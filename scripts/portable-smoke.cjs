const { launchPortable } = require("./portable-harness.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
async function main() {
  const root = path.resolve(__dirname, "..");
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-portable-"));
  const executablePath =
    process.argv[2] ||
    path.join(
      root,
      `release/ArkMC-Studio-${require("../package.json").version}-Windows-x64.exe`,
    );
  const toolsRoot = path.join(temp, "managed-tools");
  const env = {
    ...process.env,
    ARK_MC_DATA: temp,
    ARK_MC_TOOLS: toolsRoot,
    ARK_MC_NO_DISCOVER: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  async function launch() {
    app = await launchPortable(executablePath, env);
    const page = await app.firstWindow();
    await page.waitForSelector(".welcome", { timeout: 60000 });
    const bootstrap = await page.evaluate(() => window.ark.call("bootstrap"));
    assert.equal(bootstrap.instances.length, 0);
    assert.equal(bootstrap.agentVersion, require("../package.json").version);
    const resources = await app.evaluate(() => process.resourcesPath);
    for (const name of [
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "notices/npm-licenses.txt",
    ])
      assert(
        (await fs.stat(path.join(resources, name))).size > 0,
        `便携程序缺少 ${name}`,
      );
    return JSON.parse(
      await fs.readFile(path.join(temp, ".agent-state.json"), "utf8"),
    );
  }
  async function close() {
    if (!app) return;
    await app.close();
    app = undefined;
  }
  try {
    const initial = await launch();
    const hosts = await fs.readdir(path.join(toolsRoot, "desktop-host"));
    const host = path.join(
      toolsRoot,
      "desktop-host",
      hosts.find((name) => !name.startsWith(".")),
    );
    for (const relative of [
      "agent/agent.cjs",
      "direct/host.cjs",
      "network/worker.cjs",
      "server/host.cjs",
      "runtime/node.exe",
      "runtime/uv.exe",
      "telemetry.ps1",
      "dpapi.ps1",
      "probes/route-check.exe",
      "signal-router/router.py",
    ])
      assert((await fs.stat(path.join(host, relative))).size > 0);
    await close();
    process.kill(initial.pid, 0);
    const reopened = await launch();
    assert.equal(reopened.pid, initial.pid);
    const lastApp = app;
    await app.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 30);
      return true;
    });
    let exited = false;
    for (let n = 0; n < 100; n++) {
      try {
        process.kill(reopened.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") {
          exited = true;
          break;
        }
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(exited, "便携程序完整退出必须同时关闭后台");
    await lastApp.close();
    app = undefined;
    await fs.writeFile(
      path.join(root, "test-results/portable-smoke.json"),
      JSON.stringify(
        {
          passed: true,
          checkedAt: new Date().toISOString(),
          standalone: true,
          desktopCrashRecovery: true,
          reconnect: true,
          completeExitClosesBackend: true,
          resourceFiles: true,
          unifiedProgramVersion: true,
          embeddedDocumentationAndLicenses: true,
          toolsDirectoryIsolated: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "便携 EXE 验证通过：独立启动、资源完整、桌面异常退出后重连、正常退出同时关闭后台。",
    );
  } finally {
    await close();
    try {
      const state = JSON.parse(
        await fs.readFile(path.join(temp, ".agent-state.json"), "utf8"),
      );
      process.kill(state.pid);
    } catch {}
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
