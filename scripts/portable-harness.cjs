const { chromium } = require("playwright");
const net = require("node:net");
const { spawn } = require("node:child_process");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function launchPortable(executablePath, env) {
  const inspectorPort = await freePort();
  const browserPort = await freePort();
  const child = spawn(
    executablePath,
    [
      `--inspect=127.0.0.1:${inspectorPort}`,
      `--remote-debugging-port=${browserPort}`,
      "--hidden",
    ],
    { env, windowsHide: true, stdio: "ignore" },
  );
  let failure;
  child.on("error", (error) => (failure = error));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let browser;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try {
      const response = await fetch(
        `http://127.0.0.1:${browserPort}/json/version`,
        { signal: AbortSignal.timeout(1000) },
      );
      if (response.ok) {
        browser = await chromium.connectOverCDP(
          `http://127.0.0.1:${browserPort}`,
          { timeout: 20000 },
        );
        break;
      }
    } catch {}
    await wait(500);
  }
  if (!browser) throw new Error("便携程序调试连接超时");
  async function evaluate(fn) {
    const targets = await fetch(
      `http://127.0.0.1:${inspectorPort}/json/list`,
    ).then((r) => r.json());
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("主进程测试调用超时"));
      }, 10000);
      ws.addEventListener("open", () => {
        const expression = `(${fn.toString()})(process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron'))`;
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      });
      ws.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);
        if (data.id !== 1) return;
        clearTimeout(timeout);
        ws.close();
        if (data.result?.exceptionDetails)
          reject(new Error(data.result.exceptionDetails.text));
        else resolve(data.result?.result?.value);
      });
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("主进程调试连接失败"));
      });
    });
  }
  return {
    firstWindow: async () => {
      for (let n = 0; n < 60; n++) {
        const pages = browser.contexts()[0]?.pages() || [];
        if (pages.length) return pages[0];
        await wait(500);
      }
      throw new Error("便携程序窗口未建立");
    },
    evaluate,
    close: async () => {
      await evaluate(({ app }) => {
        setTimeout(() => app.exit(0), 50);
        return true;
      }).catch(() => {});
      await Promise.race([exited, wait(15000)]);
      await browser.close().catch(() => {});
    },
  };
}
module.exports = { launchPortable };
