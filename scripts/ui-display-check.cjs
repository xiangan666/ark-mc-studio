const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-display-"));
  const data = path.join(temp, "data");
  const server = path.join(temp, "高 DPI 测试实例");
  await fs.mkdir(server, { recursive: true });
  await fs.writeFile(
    path.join(server, "bedrock_server.exe"),
    "fixture, never launched",
  );
  await fs.writeFile(
    path.join(server, "server.properties"),
    "server-name=高 DPI 检查\nlevel-name=显示测试\nmax-players=20\nserver-port=29542\n",
  );
  const results = [];
  let app;
  const close = async () => {
    if (!app) return;
    const opened = app;
    app = undefined;
    await Promise.race([
      opened.evaluate(({ app }) => app.exit(0)).catch(() => {}),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    if (opened.process().exitCode === null) opened.process().kill();
    await Promise.race([
      opened.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  };
  try {
    for (const scale of [1.25, 1.5, 2]) {
      const env = {
        ...process.env,
        ARK_MC_DATA: data,
        ARK_MC_TOOLS: path.join(temp, "tools"),
        ARK_MC_NO_DISCOVER: "1",
      };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await electron.launch({
        args: [root, "--hidden", `--force-device-scale-factor=${scale}`],
        env,
        timeout: 60000,
      });
      const page = await app.firstWindow();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.waitForSelector(".welcome, main h1", { timeout: 45000 });
      const state = await page.evaluate(() => window.ark.call("bootstrap"));
      if (!state.instances.length)
        await page.evaluate(async (root) => {
          await window.ark.call("instances.import", { root });
        }, server);
      await page.evaluate(() =>
        window.ark.call("settings.save", { reducedMotion: true }),
      );
      await page.reload();
      await page.waitForSelector("main h1");
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1060, 700),
      );
      for (const theme of ["dark", "light"]) {
        await page.evaluate(
          (theme) => window.ark.call("settings.save", { theme }),
          theme,
        );
        for (const key of [
          "overview",
          "network",
          "config",
          "files",
          "settings",
          "instances",
        ]) {
          const item = page.locator(`[data-page="${key}"]`);
          if (!(await item.isVisible()))
            await item
              .locator("..")
              .locator("..")
              .locator(".nav-group-label")
              .click();
          await item.click();
          await page.waitForTimeout(100);
          const layout = await page.evaluate(() => ({
            dpr: devicePixelRatio,
            width: innerWidth,
            overflow:
              document.querySelector("main").scrollWidth >
              document.querySelector("main").clientWidth + 1,
          }));
          assert.equal(layout.overflow, false, `${scale} ${theme} ${key}`);
          assert.ok(
            Math.abs(layout.dpr - scale) < 0.02,
            `Chromium scale did not apply: ${layout.dpr}`,
          );
          results.push({ scale, theme, key, ...layout });
          if (theme === "dark" && key === "overview")
            await page.screenshot({
              path: path.join(
                root,
                "test-results",
                `display-${scale * 100}.png`,
              ),
            });
        }
      }
      assert.deepEqual(errors, []);
      await close();
      console.log(`DPI ${scale * 100}% 深浅主题与 1060×700 布局通过`);
    }
    await fs.writeFile(
      path.join(root, "test-results/ui-display-results.json"),
      JSON.stringify(
        {
          passed: true,
          at: new Date().toISOString(),
          method:
            "Electron --force-device-scale-factor; no Windows display setting changed",
          checks: results,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
    try {
      const state = JSON.parse(
        await fs.readFile(path.join(data, ".agent-state.json"), "utf8"),
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
