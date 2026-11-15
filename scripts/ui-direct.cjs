const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { createHash, randomBytes } = require("node:crypto");
const assert = require("node:assert/strict");

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-direct-ui-"));
  const data = path.join(temp, "data"),
    tools = path.join(temp, "tools"),
    instance = path.join(temp, "fixture");
  let app, control;
  const errors = [];
  try {
    await fs.mkdir(instance, { recursive: true });
    await fs.writeFile(
      path.join(instance, "bedrock_server.exe"),
      "fixture, never launched",
    );
    await fs.writeFile(
      path.join(instance, "server.properties"),
      "level-name=fixture\nserver-port=29432\nserver-portv6=29433\ntransport=nethernet\n",
    );
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
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(".welcome", { timeout: 45000 });
    await page.evaluate(
      async (root) => window.ark.call("instances.import", { root }),
      instance,
    );
    const id = await page.evaluate(
      async () => (await window.ark.call("bootstrap")).instances[0].id,
    );
    const directory = path.join(tools, "direct", id);
    await fs.mkdir(directory, { recursive: true });
    const token = randomBytes(32).toString("hex");
    await fs.writeFile(
      path.join(directory, "route.json"),
      JSON.stringify({
        version: 1,
        enabled: false,
        name: "本机 IPv6 公网直连",
        domain: "home.example.com",
        httpsPort: 8443,
        udpPort: 19139,
        upstreamPort: 29432,
        localIPv4: "127.0.0.1",
        localUdpPort: 29432,
        interfaceName: "fixture",
        hostId: "38b",
        controlToken: token,
      }),
    );
    await fs.writeFile(
      path.join(directory, "diagnosis.json"),
      JSON.stringify({
        testedAt: new Date().toISOString(),
        scope: "隔离界面样本，不代表真实公网验证。",
        checks: [
          {
            name: "IPv6 ICE / DTLS / SCTP",
            ok: true,
            detail: "fixture result",
          },
        ],
      }),
    );
    const pipe =
      "\\\\.\\pipe\\arkmc-direct-" +
      createHash("sha256")
        .update(directory.toLowerCase())
        .digest("hex")
        .slice(0, 24);
    control = net.createServer((socket) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk;
        if (!text.includes("\n")) return;
        const request = JSON.parse(text);
        if (request.token !== token) return socket.end();
        if (request.action === "stop") {
          socket.end('{"ok":true}\n');
          control.close();
        } else
          socket.end(
            JSON.stringify({
              configured: true,
              running: true,
              ready: true,
              enabled: true,
              publicIPv6: "2001:db8::38b",
              certificateExpires: new Date(
                Date.now() + 60 * 86400000,
              ).toUTCString(),
              certificateRenewal: "隔离测试证书",
              sessions: 2,
              receivedBytes: 1024,
              sentBytes: 2048,
            }) + "\n",
          );
      });
    });
    await new Promise((resolve, reject) => {
      control.once("error", reject);
      control.listen(pipe, resolve);
    });
    await page.reload();
    await page.waitForSelector(".world-hero");
    const cpu = page
      .locator(".dashboard-middle .chart-tabs button")
      .filter({ hasText: "CPU" })
      .locator("span");
    assert.equal(await cpu.textContent(), "—", "未采集的 CPU 不能显示在线人数");
    const nav = page
      .locator(".sidebar .nav-item")
      .filter({ hasText: "网络线路" });
    if (!(await nav.isVisible()))
      await nav.locator("..").locator("..").locator(".nav-group-label").click();
    await nav.click();
    const card = page.locator(".routes-grid > .ipv6-direct-route");
    await card.waitFor({ timeout: 15000 });
    await card.getByText("直连服务就绪", { exact: true }).waitFor();
    assert.equal(
      await card.getByText("home.example.com", { exact: true }).count(),
      1,
    );
    assert.equal(await card.getByText("检测通过", { exact: true }).count(), 1);
    await card
      .getByRole("button", { name: "IPv6 地址、证书与传输状态" })
      .click();
    await card.getByText("2001:db8::38b", { exact: true }).waitFor();
    await fs.mkdir(path.join(root, "test-results"), { recursive: true });
    for (const [w, h] of [
      [1060, 700],
      [1440, 940],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, { w, h }) =>
          BrowserWindow.getAllWindows()[0].setSize(w, h),
        { w, h },
      );
      await page.waitForTimeout(200);
      assert(
        await page.evaluate(
          () =>
            document.querySelector("main").scrollWidth <=
            document.querySelector("main").clientWidth + 1,
        ),
      );
      await page.screenshot({
        path: path.join(root, "test-results", `ipv6-direct-fixture-${w}.png`),
      });
    }
    await card.getByRole("button", { name: "停止直连", exact: true }).click();
    await card.getByText("已停止", { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(directory, "route.json"), "utf8"))
        .enabled,
      false,
    );
    assert.equal(
      await page.evaluate(
        async () => (await window.ark.call("bootstrap")).snapshots[0].pid,
      ),
      null,
    );
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(root, "test-results", "ui-direct-results.json"),
      JSON.stringify(
        {
          passed: true,
          isolated: true,
          cardInRouteGrid: true,
          persistedHandshakeVisible: true,
          directOnlyInstanceVisible: true,
          missingCpuIsNotPlayerCount: true,
          stopIndependentOfGame: true,
          sizes: [1060, 1440],
          errors,
        },
        null,
        2,
      ),
    );
    console.log(
      "IPv6 线路卡片、持久检测结果、详情、独立启停及两种窗口尺寸验证通过。",
    );
  } finally {
    if (app) {
      await Promise.race([
        app.evaluate(({ app }) => app.exit(0)).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (app.process().exitCode === null) app.process().kill();
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    if (control?.listening) control.close();
    try {
      const state = JSON.parse(
        await fs.readFile(path.join(data, ".agent-state.json"), "utf8"),
      );
      process.kill(state.pid);
    } catch {}
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
