const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");

// Runs only inside ui-check's disposable workspace, after the existing flows.
module.exports = async function verifyWorkstation({
  page,
  app,
  temp,
  dataRoot,
  artifacts,
  server,
}) {
  assert.equal(path.dirname(dataRoot), temp);
  const rpc = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.ark.call(method, args), {
      method,
      args,
    });
  const nav = async (name) => {
    const item = page.locator(".sidebar .nav-item").filter({ hasText: name });
    if (!(await item.isVisible()))
      await item
        .locator("..")
        .locator("..")
        .locator(".nav-group-label")
        .click();
    await item.click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
  };
  const before = await rpc("bootstrap");
  assert(
    before.instances.every(
      (i) => !path.relative(temp, i.root).startsWith(".."),
    ),
  );
  assert(before.snapshots.every((s) => !s.pid));
  const first = before.instances.find(
    (i) => path.resolve(i.root) === path.resolve(server),
  );
  const second = before.instances.find((i) => i.id !== first.id);
  assert(first && second);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dataRoot, "arkmc.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  const metric = db.prepare("INSERT INTO metrics VALUES(?,?,?,?,?,?,?)");
  const now = Date.now();
  for (let i = 0; i < 100; i++)
    metric.run(
      first.id,
      now - (100 - i) * 30000,
      35 + (i % 20),
      (1.2 + i / 200) * 1024 ** 3,
      null,
      null,
      i % 5,
    );
  db.close();
  await fs.appendFile(
    path.join(server, "logs/arkmc-server.log"),
    "\nERROR EADDRINUSE port 1234\nERROR EADDRINUSE port 2345\nWARN fixture disk warning\n",
  );
  await page.waitForFunction(
    async (id) =>
      (await window.ark.call("console.logs", { id })).some((line) =>
        line.text.includes("EADDRINUSE"),
      ),
    first.id,
  );
  const protectedPaths = [
    path.join(server, "server.properties"),
    path.join(temp, "线路测试工具/tunnel-summary.json"),
    path.join(temp, "线路测试工具/signal-routers.json"),
  ];
  const hash = async () =>
    Promise.all(
      protectedPaths.map(async (file) =>
        createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex"),
      ),
    );
  const beforeHashes = await hash();
  await nav("运行分析");
  await page.getByLabel("选择服务器实例").selectOption(first.id);
  await page
    .locator(".analysis-stat")
    .first()
    .locator("strong")
    .filter({ hasText: "%" })
    .waitFor();
  await page.getByRole("tab", { name: /^观察与建议/ }).click();
  await page.getByText("缓存中有 2 条错误日志", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "日志归类", exact: true }).click();
  assert.equal(await page.locator(".log-pattern-list>div").count(), 2);
  await page.getByText("2 次", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "运维与入口", exact: true }).click();
  await page.locator(".analysis-route-list>div").first().waitFor();
  assert.equal(await page.locator(".analysis-route-list>div").count(), 3);
  await page.getByRole("tab", { name: "性能趋势", exact: true }).click();
  await page.getByRole("button", { name: "15 分钟", exact: true }).click();
  await page.getByText("最近 15 分钟 · CPU 使用率", { exact: true }).waitFor();
  await page.getByRole("button", { name: "1 小时", exact: true }).click();
  await page.getByRole("img", { name: /CPU 使用率趋势图/ }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".analysis-page button")].some(
      (button) => button.textContent.trim() === "刷新数据" && !button.disabled,
    ),
  );
  await app.evaluate(({ dialog }, folder) => {
    globalThis.__workstationSaved = [];
    dialog.showSaveDialog = async (...args) => {
      const name = args.at(-1).defaultPath;
      const filePath = `${folder}\\${name}`;
      globalThis.__workstationSaved.push(filePath);
      return { canceled: false, filePath };
    };
  }, temp);
  await page.getByRole("button", { name: "导出摘要", exact: true }).click();
  await page
    .getByText("分析摘要已导出，不含日志正文与连接凭据", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await page.getByText("性能数据已导出", { exact: true }).waitFor();
  const exports = await app.evaluate(() => globalThis.__workstationSaved);
  const report = JSON.parse(
    await fs.readFile(
      exports.find((p) => p.endsWith(".json")),
      "utf8",
    ),
  );
  // Compatible backends aggregate this window into 5-second or minute buckets.
  assert(report.sampleCount >= 50);
  assert(report.metrics.cpu.count >= 50 && report.metrics.cpu.count <= 100);
  assert(Math.abs(report.metrics.cpu.average - 44.5) < 1);
  assert.equal(report.metrics.tps.count, 0);
  assert(
    Object.values(report.sources).every(
      (source) => source.loaded && !source.failed,
    ),
  );
  assert.equal(report.network.entries, 3);
  assert.equal(report.logs.counts.ERROR, 2);
  assert(!JSON.stringify(report).includes(server));
  assert(!JSON.stringify(report).includes("example.invalid"));
  assert(!JSON.stringify(report).includes("EADDRINUSE"));
  assert(
    (
      await fs.readFile(
        exports.find((p) => p.endsWith(".csv")),
        "utf8",
      )
    ).startsWith("\uFEFFtime,cpu_percent,memory_bytes"),
  );
  await page.screenshot({
    path: path.join(artifacts, "workstation-analysis.png"),
  });
  await nav("网络线路");
  await page.getByRole("button", { name: "紧凑总览", exact: true }).click();
  assert.equal(await page.locator(".network-overview tbody tr").count(), 3);
  await page.getByPlaceholder("搜索线路名或玩家地址…").fill("domestic.example");
  assert.equal(await page.locator(".network-overview tbody tr").count(), 1);
  await page.getByRole("button", { name: "导出入口", exact: true }).click();
  await page
    .getByText("玩家入口已导出，不包含客户端令牌", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "管理详情", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector("#network-routes").hidden,
  );
  assert.equal(await page.locator("#network-routes>.route-card").count(), 3);
  await page.getByRole("button", { name: "紧凑总览", exact: true }).click();
  await page.getByLabel("筛选玩家入口").selectOption("unverified");
  assert.equal(await page.locator(".network-overview tbody tr").count(), 2);
  await page.getByLabel("筛选玩家入口").selectOption("all");
  await page.getByLabel("选择服务器实例").selectOption(second.id);
  // Instance selection restores that instance's last page by design.
  await nav("网络线路");
  await page
    .getByRole("heading", { name: "接入现有内网穿透", exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("domestic.example.invalid", { exact: true }).count(),
    0,
  );
  await page.getByLabel("选择服务器实例").selectOption(first.id);
  await nav("网络线路");
  await page.locator(".network-overview tbody tr").first().waitFor();
  assert.equal(await page.locator(".network-overview tbody tr").count(), 3);
  await page.screenshot({
    path: path.join(artifacts, "workstation-network-overview.png"),
  });
  await page.getByRole("button", { name: "管理卡片", exact: true }).click();
  await nav("服务器总览");
  await page.locator("button.route-summary").first().waitFor();
  assert.equal(await page.locator("button.route-summary").count(), 3);
  await page.locator("button.route-summary").first().click();
  await page.waitForFunction(() =>
    document.activeElement?.closest("#route-tunnel-91001"),
  );
  await nav("实时控制台");
  await page
    .locator(".console-insights")
    .getByRole("button", { name: /错误/ })
    .click();
  assert.equal(await page.getByLabel("筛选日志等级").inputValue(), "ERROR");
  await nav("任务与记录");
  await page.getByRole("button", { name: "历史任务", exact: true }).click();
  await page.getByLabel("筛选任务结果").selectOption("issues");
  assert.equal(await page.locator(".task-list .badge.green").count(), 0);
  await page
    .getByRole("button", { name: "切换为紧凑布局", exact: true })
    .click();
  await page.waitForFunction(
    () => document.documentElement.dataset.density === "compact",
  );
  await page.reload();
  await page.waitForSelector(".sidebar .nav-item");
  await page.waitForFunction(
    () => document.documentElement.dataset.density === "compact",
  );
  await page
    .getByRole("button", { name: "切换为舒适布局", exact: true })
    .click();
  await nav("运行分析");
  const after = await rpc("bootstrap");
  assert.deepEqual(
    after.jobs.map((j) => j.id).sort(),
    before.jobs.map((j) => j.id).sort(),
    "readonly analytics must not enqueue jobs",
  );
  assert.deepEqual(
    await hash(),
    beforeHashes,
    "analysis/navigation must not change fixture core or route config",
  );
  await fs.writeFile(
    path.join(artifacts, "ui-workstation-results.json"),
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        analysisStatistics: true,
        logGrouping: true,
        jsonAndCsvExport: true,
        exportOmitsPrivateData: true,
        routeOverviewSearchAndFilters: true,
        routeAddressExport: true,
        crossInstanceResultsIsolated: true,
        overviewIncludesAllRoutes: true,
        densityPersistent: true,
        taskResultFilter: true,
        consoleSeverityFilter: true,
        readOnlyJobsAndConfig: true,
      },
      null,
      2,
    ),
  );
  console.log("1.3 运行分析、导出、线路总览、跨实例隔离、密度与只读保护通过。");
};
