const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

module.exports = async ({ page, app, temp, artifacts }) => {
  const state = await page.evaluate(() => window.ark.call("bootstrap"));
  const instance = state.instances.find((i) => i.tunnelRoot);
  assert(
    instance &&
      path
        .resolve(instance.tunnelRoot)
        .startsWith(path.resolve(temp) + path.sep),
  );
  const summaryFile = path.join(instance.tunnelRoot, "tunnel-summary.json");
  const routerFile = path.join(instance.tunnelRoot, "signal-routers.json");
  const summary = await fs.readFile(summaryFile, "utf8"),
    routers = await fs.readFile(routerFile, "utf8");
  const receipt = path.join(temp, "tools/bin/frp/current.json");
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  await fs.writeFile(
    path.join(path.dirname(receipt), "frpc.exe"),
    "isolated UI fixture, never run",
  );
  await fs.writeFile(
    receipt,
    JSON.stringify({ executable: "bin/frp/frpc.exe", version: "fixture" }),
  );
  try {
    await fs.writeFile(
      summaryFile,
      JSON.stringify([
        ...JSON.parse(summary),
        {
          id: 850,
          provider: "frp-panel",
          node: "云 FRP · 隔离验收",
          serverAddr: "192.0.2.50",
          proxies: [
            {
              type: "udp",
              localIP: "192.0.2.200",
              localPort: 29432,
              remotePort: 19132,
            },
            {
              type: "tcp",
              localIP: "127.0.0.1",
              localPort: 29532,
              remotePort: 19132,
              publicPort: 19132,
              customDomains: ["cloud.example.invalid"],
              AutoTLS: true,
            },
          ],
        },
      ]),
    );
    await fs.writeFile(
      routerFile,
      JSON.stringify([
        ...JSON.parse(routers),
        {
          key: "cloud-850",
          name: "云 FRP · 隔离验收",
          enabled: true,
          signalId: 850,
          udpId: 850,
          listenIP: "127.0.0.1",
          listenPort: 29532,
          upstream: "http://127.0.0.1:29432",
          sourceUdpIP: "192.0.2.10",
          sourceUdpPort: 34051,
          publicUdpIP: "192.0.2.50",
          publicUdpPort: 19132,
          relayOnly: true,
        },
      ]),
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1440, 940),
    );
    await page.reload();
    await page.locator('.nav-item[data-page="network"]').click();
    await page.getByRole("tab", { name: "信令转接", exact: true }).click();
    const hub = page.locator(".signal-hub");
    await hub
      .locator("tbody tr")
      .filter({ hasText: "cloud.example.invalid" })
      .waitFor();
    assert.equal(await hub.locator("tbody tr").count(), 4);
    const row = hub
      .locator("tbody tr")
      .filter({ hasText: "cloud.example.invalid" });
    assert.match(await row.innerText(), /192\.0\.2\.50:19132/);
    assert.equal(
      await row
        .getByRole("button", { name: "启动客户端", exact: true })
        .count(),
      1,
    );
    assert.match(await row.innerText(), /TCP \/ UDP 同时启停/);
    const recognized = hub
      .locator(".signal-client.ready")
      .filter({ hasText: "官方 FRP" });
    assert.equal(await recognized.count(), 1);
    await page.getByRole("tab", { name: "客户端", exact: true }).click();
    const panel = page
      .getByRole("heading", { name: "隧道进程", exact: true })
      .locator(
        'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," panel ")][1]',
      );
    const client = panel.locator("tbody tr").filter({ hasText: "#850" });
    assert.equal(await client.count(), 1, "TCP / UDP 不应重复显示成两个进程");
    assert.match(await client.innerText(), /UDP \+ TCP 共用一个进程/);
    assert.match(await client.innerText(), /UDP · 192\.0\.2\.200:29432/);
    assert.match(await client.innerText(), /TCP · 127\.0\.0\.1:29532/);
    await page.locator("main").evaluate((e) => e.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(artifacts, "network-cloud-frp.png"),
    });
    console.log(
      "云 FRP 界面验收通过：官方工具识别、TCP/UDP 共用进程、独立目标和启停提示。",
    );
  } finally {
    await fs.writeFile(summaryFile, summary);
    await fs.writeFile(routerFile, routers);
    await page.reload();
    await page.locator('.nav-item[data-page="network"]').click();
    await page.getByRole("tab", { name: "信令转接", exact: true }).click();
    await page.locator(".signal-hub tbody tr").first().waitFor();
  }
};
