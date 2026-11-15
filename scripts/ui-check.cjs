const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
async function main() {
  const root = path.resolve(__dirname, "..");
  const artifacts = path.join(root, "test-results");
  await fs.mkdir(artifacts, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-ui-"));
  const server = path.join(temp, "中文测试实例");
  await fs.mkdir(path.join(server, "worlds", "测试世界", "db"), {
    recursive: true,
  });
  await fs.mkdir(path.join(server, "logs"), { recursive: true });
  await fs.writeFile(
    path.join(server, "bedrock_server.exe"),
    "test fixture, never launched",
  );
  await fs.writeFile(
    path.join(server, "server.properties"),
    "# keep this comment\r\nserver-name=界面测试实例\r\nlevel-name=测试世界\r\nmax-players=20\r\nserver-port=29432\r\nserver-portv6=29433\r\ngamemode=survival\r\ndifficulty=easy\r\nonline-mode=false\r\ntransport=raknet\r\n",
  );
  await fs.writeFile(
    path.join(server, "worlds", "测试世界", "level.dat"),
    "fixture",
  );
  await fs.writeFile(
    path.join(server, "logs", "arkmc-server.log"),
    "[12:00:00 INFO]: Version: 1.26.60.6\n[12:00:01 INFO]: Server started.\n" +
      Array.from(
        { length: 6000 },
        (_, i) => `[12:00:02 INFO]: Fixture log ${i}`,
      ).join("\n"),
  );
  await fs.mkdir(path.join(server, "大目录"), { recursive: true });
  for (let i = 0; i < 1000; i++)
    await fs.writeFile(
      path.join(server, "大目录", `entry-${String(i).padStart(4, "0")}.txt`),
      "fixture",
    );
  await fs.mkdir(path.join(server, "behavior_packs", "fixture-pack"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(server, "behavior_packs", "fixture-pack", "manifest.json"),
    JSON.stringify({
      format_version: 2,
      header: {
        name: "界面测试行为包",
        description: "隔离界面样本",
        uuid: "c0065a48-b604-4f85-979f-f472db7ad7b9",
        version: [1, 0, 0],
        min_engine_version: [1, 26, 0],
      },
      modules: [
        {
          type: "data",
          uuid: "27054f58-447d-443c-b628-e15aa99071ae",
          version: [1, 0, 0],
        },
      ],
    }),
  );
  const dataRoot = path.join(temp, "data");
  let app;
  const errors = [];
  try {
    const env = {
      ...process.env,
      ARK_MC_DATA: dataRoot,
      ARK_MC_NO_DISCOVER: "1",
      ARK_MC_TOOLS: path.join(temp, "tools"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      args: [root, "--hidden"],
      env,
      timeout: 60000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
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
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.waitForSelector(".welcome", { timeout: 45000 });
    await page.evaluate(async (root) => {
      await window.ark.call("instances.import", { root });
      await window.ark.call("settings.save", { reducedMotion: true });
    }, server);
    await page.reload();
    await page.waitForSelector(".world-hero", { timeout: 15000 });
    assert.equal(
      (await page.locator(".brand .badge").innerText()).trim(),
      require("../package.json").version,
    );
    await page.screenshot({
      path: path.join(artifacts, "fixture-overview.png"),
    });
    console.log("Overview ready");
    const names = [
      "运行分析",
      "实时控制台",
      "玩家与权限",
      "世界管理",
      "模组与插件",
      "文件管理",
      "服务器配置",
      "备份与恢复",
      "网络线路",
      "工具与环境",
      "自动化计划",
      "任务与记录",
      "实例管理",
      "应用设置",
    ];
    for (const name of names) {
      console.log("Checking", name);
      await navigate(name);
      await page.waitForTimeout(500);
      assert(
        (await page.locator("main h1").count()) > 0,
        `${name} missing heading`,
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow, `${name} overflows window`);
    }
    console.log("Checking config save");
    await navigate("网络线路");
    const newBackendFeatures = await page.evaluate(async () => {
      const state = await window.ark.call("bootstrap");
      const id = state.instances[0].id;
      const quality = await window.ark.call("tunnels.quality.get", { id });
      const updates = await window.ark.call("core-updates.get", { id });
      return {
        compatible: state.agentVersion === window.ark.versions.app,
        emptyQuality: quality === null,
        autoUpdate: updates.policy.autoUpdate,
        incompatibleEndstone: updates.policy.incompatibleEndstone,
      };
    });
    assert.deepEqual(newBackendFeatures, {
      compatible: true,
      emptyQuality: true,
      autoUpdate: false,
      incompatibleEndstone: "wait",
    });
    await page.getByRole("button", { name: "导入隧道", exact: true }).click();
    await page.getByLabel(/^访问令牌/).fill("fixture-secret-do-not-submit");
    await page.getByLabel("内网穿透服务商").selectOption("sakura");
    assert.equal(await page.getByLabel(/^访问令牌/).inputValue(), "");
    assert.ok(await page.getByText(/樱花 TCP 请开启自动 HTTPS/).count());
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await navigate("工具与环境");
    await page.waitForSelector(".tool-card");
    assert.equal(await page.locator(".tool-card").count(), 3);
    assert.ok(
      await page.getByRole("button", { name: "检查更新", exact: true }).count(),
    );
    await page.screenshot({ path: path.join(artifacts, "tools-center.png") });
    await navigate("服务器配置");
    await page.waitForSelector(".config-fields");
    await page.getByLabel("服务器名称").fill("已通过界面保存");
    await page.getByRole("button", { name: "预览并保存" }).click();
    await page.getByRole("button", { name: "保留历史并保存" }).click();
    await page.waitForTimeout(600);
    assert.match(
      await fs.readFile(path.join(server, "server.properties"), "utf8"),
      /server-name=已通过界面保存/,
    );
    assert.match(
      await fs.readFile(path.join(server, "server.properties"), "utf8"),
      /# keep this comment/,
    );
    await navigate("备份与恢复");
    await page.getByRole("button", { name: "立即备份世界" }).click();
    await page.waitForTimeout(2500);
    await navigate("任务与记录");
    await page.getByRole("button", { name: "历史任务", exact: true }).click();
    await page.waitForSelector(".task-icon.success", { timeout: 20000 });
    await navigate("应用设置");
    await page.getByRole("button", { name: /晨光/ }).click();
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    await page.screenshot({ path: path.join(artifacts, "fixture-light.png") });
    await page.getByRole("button", { name: /黑曜石/ }).click();
    await page.getByRole("tab", { name: "后台与启动", exact: true }).click();
    const beforeReload = JSON.parse(
      await fs.readFile(path.join(dataRoot, ".agent-state.json"), "utf8"),
    );
    const reload = page.getByRole("button", {
      name: "安全重载后台",
      exact: true,
    });
    await reload.click();
    await page
      .getByText("管理后台已重载并重新连接", { exact: true })
      .waitFor({ timeout: 60000 });
    const afterReload = JSON.parse(
      await fs.readFile(path.join(dataRoot, ".agent-state.json"), "utf8"),
    );
    assert.notEqual(afterReload.pid, beforeReload.pid);
    await require("./ui-integrated.cjs")({
      page,
      app,
      root,
      temp,
      dataRoot,
      artifacts,
    });
    await require("./ui-network-upgrade.cjs")({
      page,
      app,
      root,
      temp,
      dataRoot,
      artifacts,
    });
    await require("./ui-redesign.cjs")({
      page,
      app,
      root,
      temp,
      dataRoot,
      artifacts,
      server,
    });
    await require("./ui-workstation.cjs")({
      page,
      app,
      root,
      temp,
      dataRoot,
      artifacts,
      server,
    });
    await require("./ui-workspace-design.cjs")({ page, app, artifacts });
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".palette-search");
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(artifacts, "ui-results.json"),
      JSON.stringify(
        {
          passed: true,
          pages: names.length + 1,
          configSave: true,
          worldBackup: true,
          lightTheme: true,
          newBackendFeatures: true,
          safeBackendReload: true,
          overviewCoreUpdates: true,
          integratedRouteCards: true,
          minimumWindow: true,
          workspaceDesign: true,
          layoutMatrixSkipped: process.argv.includes("--skip-layout-matrix"),
          errors,
        },
        null,
        2,
      ),
    );
    console.log(
      "桌面 UI 验证通过：15 个页面、运行分析、线路总览、中文配置保存、世界备份、主题密度与命令面板。",
    );
  } catch (error) {
    if (app) {
      await Promise.race([
        app
          .firstWindow()
          .then((page) =>
            page.screenshot({
              path: path.join(artifacts, "ui-failure.png"),
              timeout: 5000,
            }),
          )
          .catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    console.error(error);
    throw error;
  } finally {
    if (app) {
      await Promise.race([
        app.evaluate(({ app }) => app.exit(0)).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (app.process().exitCode === null) app.process().kill();
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
    try {
      const state = JSON.parse(
        await fs.readFile(path.join(dataRoot, ".agent-state.json"), "utf8"),
      );
      process.kill(state.pid);
    } catch {}
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
