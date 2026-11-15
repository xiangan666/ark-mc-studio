const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const assert = require("node:assert/strict");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = path.resolve(__dirname, "..");
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ark-program-ui-"));
  const data = path.join(temp, "data"),
    tools = path.join(temp, "tools");
  await fs.mkdir(data, { recursive: true });
  const pipe = `\\\\.\\pipe\\ark-upgrade-fixture-${createHash("sha256").update(temp).digest("hex").slice(0, 16)}`;
  const token = randomBytes(32).toString("hex");
  const oldFile = path.join(temp, "old-service.cjs");
  await fs.writeFile(
    oldFile,
    `
    const net=require('node:net'), fs=require('node:fs'), path=require('node:path'), rl=require('node:readline');
    const data=process.argv[2], pipe=process.argv[3], token=process.argv[4];
    const state={agentVersion:'1.1.3', instances:[], snapshots:[], jobs:[], activities:[], schedules:[], samplerReady:true,
      dataRoot:data, settings:{theme:'dark', reducedMotion:true, closeToTray:true}};
    const server=net.createServer(socket=>{socket.on('error',()=>{});rl.createInterface({input:socket}).on('line',line=>{
      const r=JSON.parse(line);if(r.token!==token)return socket.destroy();
      const ok=r.method==='bootstrap';socket.write(JSON.stringify({id:r.id,ok,data:ok?state:undefined,error:ok?undefined:'不支持的管理操作'})+'\\n');
    });});
    server.listen(pipe,()=>{
      fs.writeFileSync(path.join(data,'.agent-auth.json'),JSON.stringify({pid:process.pid,pipe,token}));
      fs.writeFileSync(path.join(data,'.agent-state.json'),JSON.stringify({pid:process.pid,version:'1.1.3'}));
    });
  `,
  );
  let app, old;
  const errors = [];
  async function launch() {
    const env = {
      ...process.env,
      ARK_MC_DATA: data,
      ARK_MC_TOOLS: tools,
      ARK_MC_NO_DISCOVER: "1",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      args: [root, "--hidden"],
      env,
      timeout: 60000,
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].show(),
    );
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    return page;
  }
  async function waitExit(pid) {
    for (let n = 0; n < 100; n++) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") return;
        throw e;
      }
      await pause(100);
    }
    throw new Error(`隔离测试进程未退出：${pid}`);
  }
  try {
    old = spawn(
      path.join(root, "resources/runtime/node.exe"),
      [oldFile, data, pipe, token],
      { windowsHide: true, stdio: "ignore" },
    );
    for (let n = 0; n < 100; n++) {
      if (
        await fs.access(path.join(data, ".agent-auth.json")).then(
          () => true,
          () => false,
        )
      )
        break;
      await pause(100);
    }
    let page = await launch();
    await page
      .getByRole("heading", { name: "检测到旧版管理服务", exact: true })
      .waitFor();
    assert.match(
      await page.locator(".program-upgrade-card").innerText(),
      /保留运行中的服务器和线路/,
    );
    assert.equal(await page.locator(".sidebar").count(), 0);
    const forbidden = await page.evaluate(() =>
      window.ark.call("tools.list", {}).then(
        () => "allowed",
        (e) => e.message,
      ),
    );
    assert.match(forbidden, /先确认保留运行/);
    await page.screenshot({
      path: path.join(root, "test-results/program-upgrade-confirm.png"),
    });
    const firstUi = app.process().pid;
    await page
      .getByRole("button", { name: "取消并退出新版", exact: true })
      .click();
    await waitExit(firstUi);
    process.kill(old.pid, 0);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(data, ".agent-state.json"))).pid,
      old.pid,
    );
    app = undefined;

    page = await launch();
    await page
      .getByRole("heading", { name: "检测到旧版管理服务", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "保留运行并更新", exact: true })
      .click();
    console.log("隔离环境：已确认保留运行并更新");
    await page.waitForSelector(".welcome", { timeout: 60000 });
    const state = await page.evaluate(() => window.ark.call("bootstrap"));
    assert.equal(state.agentVersion, require("../package.json").version);
    assert.equal(state.programUpdating, false);
    const backend = JSON.parse(
      await fs.readFile(path.join(data, ".agent-state.json")),
    );
    assert.notEqual(backend.pid, old.pid);
    await waitExit(old.pid);
    const report = JSON.parse(
      await fs.readFile(path.join(tools, "maintenance/upgrades/latest.json")),
    );
    assert.equal(report.version, require("../package.json").version);

    // A window close defaults to tray and keeps this one program running.
    await page.evaluate(() => window.ark.window("close"));
    await pause(200);
    process.kill(backend.pid, 0);
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      false,
    );
    // app.quit and the tray share requestProgramExit, exercising the production exit coordinator.
    const uiPid = app.process().pid;
    await app.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 30);
      return true;
    });
    await waitExit(uiPid);
    await waitExit(backend.pid);
    app = undefined;
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(root, "test-results/program-lifecycle-ui.json"),
      JSON.stringify(
        {
          passed: true,
          checkedAt: new Date().toISOString(),
          oldVersionGate: true,
          cancelPreservesOldService: true,
          explicitUpgrade: true,
          unifiedVersion: true,
          windowCloseToTray: true,
          completeProgramExit: true,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(
      "程序生命周期界面验证通过：旧服务确认、取消保留、显式更新、统一版本、关闭缩托盘、退出同时关闭界面和后台。",
    );
  } finally {
    if (app) {
      await Promise.race([
        app
          .evaluate(({ app }) => {
            setTimeout(() => app.exit(0), 20);
            return true;
          })
          .catch(() => {}),
        pause(3000),
      ]);
      if (app.process().exitCode === null) app.process().kill();
      await Promise.race([app.close().catch(() => {}), pause(3000)]);
    }
    for (const pid of [
      old?.pid,
      await fs
        .readFile(path.join(data, ".agent-state.json"))
        .then((s) => JSON.parse(s).pid)
        .catch(() => null),
    ]) {
      if (pid)
        try {
          process.kill(pid);
        } catch {}
    }
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
