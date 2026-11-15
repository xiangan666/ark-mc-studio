const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

// All fixtures belong to ui-check's disposable data directory, never the live instance.
module.exports = async function verifyIntegratedUI({
  page,
  app,
  root,
  temp,
  dataRoot,
  artifacts,
}) {
  assert.equal(path.dirname(dataRoot), temp);
  const navigate = async (name) => {
    const item = page.locator(".sidebar .nav-item").filter({ hasText: name });
    if (!(await item.isVisible()))
      await item
        .locator("..")
        .locator("..")
        .locator(".nav-group-label")
        .click();
    await item.click();
  };
  const state = await page.evaluate(() => window.ark.call("bootstrap"));
  const id = state.instances[0].id;
  const tunnelRoot = path.join(temp, "线路测试工具");
  await fs.mkdir(tunnelRoot, { recursive: true });
  const fixtureRoutes = [
    {
      name: "国内 · 界面测试",
      signalId: 91001,
      udpId: 91002,
      host: "domestic.example.invalid",
      udpIP: "192.0.2.10",
      udpPort: 34051,
      listenPort: 29232,
    },
    {
      name: "海外 · 界面测试",
      signalId: 92001,
      udpId: 92002,
      host: "overseas.example.invalid",
      udpIP: "192.0.2.20",
      udpPort: 32592,
      listenPort: 29332,
    },
    {
      name: "未配置转接 · 界面测试",
      signalId: 93001,
      udpId: 93002,
      host: "direct.example.invalid",
      udpIP: "192.0.2.30",
      udpPort: 35132,
    },
  ];
  const routers = fixtureRoutes
    .filter((r) => r.listenPort)
    .map((r) => ({
      key: `fixture-${r.signalId}`,
      name: r.name,
      signalId: r.signalId,
      udpId: r.udpId,
      enabled: true,
      listenIP: "127.0.0.1",
      listenPort: r.listenPort,
      upstream: "http://127.0.0.1:29432",
      sourceUdpIP: "192.0.2.10",
      sourceUdpPort: 34051,
      publicUdpIP: r.udpIP,
      publicUdpPort: r.udpPort,
      relayOnly: true,
    }));
  await fs.writeFile(
    path.join(tunnelRoot, "signal-routers.json"),
    JSON.stringify(routers),
  );
  await fs.writeFile(
    path.join(tunnelRoot, "tunnel-summary.json"),
    JSON.stringify(
      fixtureRoutes.flatMap((r) => [
        {
          id: r.signalId,
          node: r.name,
          provider: "lolia",
          proxies: [
            {
              type: "https",
              localIP: "127.0.0.1",
              localPort: r.listenPort || 29432,
              customDomains: [r.host],
            },
          ],
        },
        {
          id: r.udpId,
          node: r.name,
          provider: "lolia",
          serverAddr: r.udpIP,
          proxies: [
            {
              type: "udp",
              localIP: "192.0.2.200",
              localPort: 29432,
              remotePort: r.udpPort,
            },
          ],
        },
      ]),
    ),
  );
  const now = Date.now();
  const quality = {
    checkedAt: now,
    recommendedSignalId: 91001,
    scope: "隔离 UI 测试数据，不代表真实线路质量。",
    routes: fixtureRoutes.slice(0, 2).map((r, i) => ({
      signalId: r.signalId,
      name: r.name,
      host: r.host,
      port: 443,
      checkedAt: now - (i ? 20 * 60000 : 0),
      samples: [100, 120, 140, 160, 180].map((elapsedMs, n) => ({
        ok: i === 0 || n !== 2,
        elapsedMs,
        ...(i && n === 2 ? { error: "测试请求超时" } : {}),
      })),
      failureRate: i ? 20 : 0,
      medianMs: 140,
      p95Ms: 180,
      jitterMs: 20,
      transport: {
        status: i ? "fail" : "pass",
        detail: i ? "隔离样本：UDP 重连失败" : "隔离样本：2 次重连通过",
        connectMs: i ? undefined : 280,
      },
    })),
  };
  const updates = {
    policy: {
      autoCheck: false,
      autoUpdate: false,
      intervalHours: 6,
      maintenanceTime: "04:00",
      incompatibleEndstone: "wait",
    },
    report: {
      checkedAt: now,
      core: "endstone",
      targetCore: "endstone",
      currentBds: "1.26.60.6",
      currentEndstone: "0.11.14",
      latestBds: "1.26.61.1",
      latestEndstone: "0.11.15",
      compatibleBds: "1.26.60.6",
      updateAvailable: true,
      status: "available",
      detail:
        "隔离 UI 样本：可更新至 Endstone 官方兼容组合，最新版 BDS 等待适配。",
      releaseUrl: "https://github.com/EndstoneMC/endstone/releases",
    },
  };
  const fixtureFile = path.join(temp, "ui-state.json");
  await fs.writeFile(
    fixtureFile,
    JSON.stringify({ id, tunnelRoot, quality, updates }),
  );
  execFileSync(path.join(root, "resources/runtime/node.exe"), [
    "--no-warnings",
    "-e",
    `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=5000');
    const instance = JSON.parse(db.prepare('SELECT data FROM instances WHERE id=?').get(fixture.id).data);
    instance.tunnelRoot = fixture.tunnelRoot; instance.core = 'endstone';
    db.prepare('UPDATE instances SET data=? WHERE id=?').run(JSON.stringify(instance), fixture.id);
    const put = db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    put.run('route-quality:' + fixture.id, JSON.stringify(fixture.quality));
    put.run('core-updates:' + fixture.id, JSON.stringify(fixture.updates));
    db.close();
  `,
    path.join(dataRoot, "arkmc.sqlite"),
    fixtureFile,
  ]);

  await page.reload();
  await page.getByRole("tab", { name: "核心维护", exact: true }).click();
  const core = page.locator(".dashboard-core-updates");
  await core.getByText("Endstone 0.11.15", { exact: true }).waitFor();
  assert.match(await core.innerText(), /1\.26\.61\.1/);
  assert.match(await core.innerText(), /默认等待 Endstone 适配/);
  await core.getByRole("button", { name: "更新策略", exact: true }).click();
  assert.equal(
    await page
      .getByRole("switch", { name: "自动安装核心更新" })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    await page.getByLabel("Endstone 未适配最新版 BDS 时").inputValue(),
    "wait",
  );
  await page.getByLabel("自动安装维护时间").fill("05:15");
  await page.getByRole("button", { name: "保存更新策略", exact: true }).click();
  await page.getByText("核心更新策略已保存", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const saved = await page.evaluate(
    (id) => window.ark.call("core-updates.get", { id }),
    id,
  );
  assert.equal(saved.policy.maintenanceTime, "05:15");
  assert.equal(saved.policy.autoUpdate, false);
  await core.getByRole("button", { name: "更新核心", exact: true }).click();
  await page
    .getByRole("heading", { name: "更新服务器核心", exact: true })
    .waitFor();
  assert.match(
    await page.locator(".core-picker .selected").innerText(),
    /Endstone/,
  );
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "准备更新并创建恢复点", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  await core.screenshot({
    path: path.join(artifacts, "overview-core-updates.png"),
  });

  await navigate("网络线路");
  await page.waitForSelector(".route-card", { timeout: 15000 });
  assert.equal(await page.locator(".route-card").count(), 3);
  await page.getByRole("tab", { name: "信令转接", exact: true }).click();
  const hub = page.locator(".signal-hub");
  await hub
    .getByRole("heading", { name: "统一信令转接", exact: true })
    .waitFor();
  assert.equal(await hub.locator("tbody tr").count(), 3);
  assert.match(await hub.innerText(), /0 \/ 2 转接健康/);
  assert.match(
    await hub.locator(".signal-client").innerText(),
    /待安装 \/ 修复/,
  );
  const beforeUnify = JSON.parse(
    await fs.readFile(path.join(tunnelRoot, "signal-routers.json")),
  );
  await hub.getByRole("button", { name: "统一上游配置", exact: true }).click();
  await page
    .getByLabel("统一 MC 上游", { exact: true })
    .fill("http://localhost:29432");
  await page
    .getByRole("button", { name: "保存到 2 条线路", exact: true })
    .click();
  await page
    .getByText("所选线路的上游已统一，独立 UDP 映射保持原样", { exact: true })
    .waitFor();
  const afterUnify = JSON.parse(
    await fs.readFile(path.join(tunnelRoot, "signal-routers.json")),
  );
  assert.deepEqual(
    afterUnify.map(({ upstream, ...rest }) => rest),
    beforeUnify.map(({ upstream, ...rest }) => rest),
  );
  assert(afterUnify.every((r) => r.upstream === "http://localhost:29432"));
  await hub.screenshot({
    path: path.join(artifacts, "network-unified-signaling.png"),
  });
  await page.getByRole("tab", { name: "检测结果", exact: true }).click();
  assert.equal(
    await page
      .locator(".network-diagnostic-card .route-quality-section")
      .count(),
    3,
  );
  assert.equal(
    await page.locator(".route-card .route-router-section").count(),
    0,
  );
  assert.equal(
    await page
      .locator(".panel-heading h3")
      .filter({ hasText: /通用信令转接层|线路质量检测/ })
      .count(),
    0,
  );
  const domesticQuality = page
    .locator(".network-diagnostic-card")
    .filter({ hasText: "国内 · 界面测试" });
  const overseasQuality = page
    .locator(".network-diagnostic-card")
    .filter({ hasText: "海外 · 界面测试" });
  const directQuality = page
    .locator(".network-diagnostic-card")
    .filter({ hasText: "未配置转接 · 界面测试" });
  await domesticQuality.getByText("本机检测优选", { exact: true }).waitFor();
  assert.match(await domesticQuality.innerText(), /140 ms/);
  assert.match(await overseasQuality.innerText(), /结果已过期/);
  assert.match(await overseasQuality.innerText(), /握手失败/);
  assert.match(await directQuality.innerText(), /尚未检测/);
  await domesticQuality
    .getByRole("button", { name: "检测详情", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "国内 · 界面测试 · 质量详情", exact: true })
    .waitFor();
  assert.equal(await page.locator('[role="dialog"] tbody tr').count(), 5);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "玩家入口", exact: true }).click();
  const domestic = page
    .locator(".route-card")
    .filter({ hasText: "国内 · 界面测试" });
  const direct = page
    .locator(".route-card")
    .filter({ hasText: "未配置转接 · 界面测试" });
  await domestic.getByRole("button", { name: "转接配置", exact: true }).click();
  assert.equal(
    await page.getByLabel("信令隧道", { exact: true }).inputValue(),
    "91001",
  );
  assert.equal(
    await page.getByLabel("本机监听端口", { exact: true }).inputValue(),
    "29232",
  );
  await page.getByLabel("线路名称", { exact: true }).fill("国内 · 卡片内保存");
  await page.getByRole("button", { name: "保存转接配置", exact: true }).click();
  await page
    .getByRole("heading", { name: "国内 · 卡片内保存", exact: true })
    .waitFor();
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(tunnelRoot, "signal-routers.json"), "utf8"),
    ).find((r) => r.signalId === 91001).name,
    "国内 · 卡片内保存",
  );
  await direct.getByRole("button", { name: "转接配置", exact: true }).click();
  assert.equal(
    await page.getByLabel("信令隧道", { exact: true }).inputValue(),
    "93001",
  );
  assert.equal(
    await page.getByLabel("UDP 隧道", { exact: true }).inputValue(),
    "93002",
  );
  assert.equal(
    await page.getByLabel("上游 MC 信令", { exact: true }).inputValue(),
    "http://127.0.0.1:29432",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator(".network-summary").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(artifacts, "network-integrated-cards.png"),
    fullPage: true,
  });

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1060, 700),
  );
  for (const name of ["网络线路", "服务器总览"]) {
    await navigate(name);
    if (name === "服务器总览")
      await page.getByRole("tab", { name: "核心维护", exact: true }).click();
    const scope =
      name === "网络线路" ? ".route-card" : ".dashboard-core-updates";
    await page.waitForSelector(scope);
    assert.deepEqual(
      await page
        .locator(scope)
        .evaluateAll((elements) =>
          elements
            .filter((e) => e.scrollWidth > e.clientWidth + 1)
            .map((e) => e.className),
        ),
      [],
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(
        artifacts,
        name === "网络线路"
          ? "network-cards-1060.png"
          : "core-updates-1060.png",
      ),
    });
  }
  // The real quality command targets only a reserved .invalid fixture, never production.
  await navigate("网络线路");
  await page.getByRole("tab", { name: "检测结果", exact: true }).click();
  await directQuality
    .getByRole("button", { name: "检测本线路", exact: true })
    .click();
  // Playwright's predicate poller treats a Promise as truthy before it resolves.
  // Await each RPC explicitly so an unfinished sample cannot pass the wait.
  let result;
  let measured;
  const measurementDeadline = Date.now() + 45000;
  while (Date.now() < measurementDeadline) {
    result = await page.evaluate(
      (id) => window.ark.call("tunnels.quality.get", { id }),
      id,
    );
    measured = result?.routes.find((r) => r.signalId === 93001);
    if (measured) break;
    await page.waitForTimeout(200);
  }
  assert.ok(measured, "单线检测应保存完整质量报告");
  assert.equal(result.routes.length, 3, "单线检测应保留其他线路结果");
  assert.equal(measured.samples.length, 5);
  assert.equal(measured.failureRate, 100);
  assert.equal(measured.transport.status, "skipped");
  await directQuality.getByText("100%", { exact: true }).waitFor();
  console.log(
    "首页核心版本/更新确认/策略保存、三张线路卡片/详情/转接保存/单线检测及最小窗口验证通过。",
  );
};
