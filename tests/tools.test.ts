import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "../src/agent/store";
import { Runtime } from "../src/agent/runtime";
import { Tools, latestTool } from "../src/agent/tools";
import { Network } from "../src/agent/network";
import { json } from "../src/agent/safe";

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-tools-"));
  const root = path.join(temp, "中文实例");
  const toolsRoot = path.join(temp, "程序", "managed-tools");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "bedrock_server.exe"), "fixture only");
  await fs.writeFile(
    path.join(root, "server.properties"),
    "server-name=工具验证\nserver-port=29431\nlevel-name=保留世界\n",
  );
  const store = new Store(path.join(temp, "data"));
  const runtime = new Runtime(store, () => {}, path.resolve("resources"));
  runtime.samplerReady = true;
  const instance = await runtime.import(root);
  const tools = new Tools(store, runtime, path.resolve("resources"), toolsRoot);
  const ctx = {
    id: randomUUID(),
    signal: new AbortController().signal,
    update: () => {},
  };
  return {
    temp,
    root,
    toolsRoot,
    store,
    runtime,
    instance,
    tools,
    ctx,
    async close() {
      runtime.dispose();
      store.db.close();
      await fs.rm(temp, { recursive: true, force: true });
    },
  };
}

test("工具工作空间拒绝与核心目录嵌套", async () => {
  const f = await fixture();
  try {
    f.store.set("managed-tools-root", path.join(f.root, "tools"));
    const tools = new Tools(f.store, f.runtime, "resources");
    await assert.rejects(tools.list(), /独立存放/);
  } finally {
    await f.close();
  }
});

test("离线实例工具迁移保留数据与凭证，并能重新发现实例", async () => {
  const f = await fixture();
  try {
    const network = path.join(f.temp, "旧网络目录");
    await fs.mkdir(path.join(network, "private"), { recursive: true });
    await fs.writeFile(path.join(network, "tunnel-summary.json"), "[]");
    await fs.writeFile(
      path.join(network, "private", "tunnel-42.toml"),
      'serverAddr="example.com"\n[[proxies]]\nname="example"\ntype="https"\n[proxies.plugin.autoTLS]\ncacheDir="old"\n',
    );
    await fs.mkdir(path.join(f.toolsRoot, "bin", "lolia"), { recursive: true });
    await fs.writeFile(
      path.join(f.toolsRoot, "bin", "lolia", "current.json"),
      "{}",
    );
    await fs.writeFile(path.join(f.root, "run-server.py"), "# legacy fixture");
    await fs.writeFile(
      path.join(f.root, "tunnel-endpoint.json"),
      '{"mode":"lolia","publicUdpPort":34051}',
    );
    await fs.mkdir(path.join(f.root, "worlds", "保留世界"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(f.root, "worlds", "保留世界", "level.dat"),
      "unique-world-data",
    );
    const before = await fs.readFile(path.join(f.root, "server.properties"));
    await f.tools.organize(f.instance.id, network, f.ctx);
    const i = f.store.instance(f.instance.id);
    assert.equal(i.adapter, "managed");
    assert.equal(
      await fs.readFile(
        path.join(f.root, "worlds", "保留世界", "level.dat"),
        "utf8",
      ),
      "unique-world-data",
    );
    assert.deepEqual(
      await fs.readFile(path.join(f.root, "server.properties")),
      before,
    );
    assert.equal(await fs.stat(network).catch(() => null), null);
    assert.match(
      await fs.readFile(
        path.join(i.tunnelRoot!, "private", "tunnel-42.toml"),
        "utf8",
      ),
      /\.autotls-cache/,
    );
    assert.ok(i.endpointPath?.startsWith(f.toolsRoot));
    f.store.delete("instances", i.id);
    const discovered = await f.runtime.import(
      f.root,
      path.join(f.temp, "不存在的旧隧道目录"),
    );
    assert.equal(discovered.id, i.id);
    assert.equal(discovered.endpointPath, i.endpointPath);
    assert.equal(discovered.tunnelRoot, i.tunnelRoot);
  } finally {
    await f.close();
  }
});

test("迁移冲突时回退目录和配置", async () => {
  const f = await fixture();
  try {
    const netRoot = path.join(f.temp, "network");
    await fs.mkdir(path.join(netRoot, "private"), { recursive: true });
    await fs.writeFile(
      path.join(netRoot, "private", "tunnel-1.toml"),
      'serverAddr="fixture"',
    );
    await fs.writeFile(path.join(f.root, "run-server.py"), "original");
    const conflict = path.join(
      f.toolsRoot,
      "instances",
      f.instance.id,
      "legacy",
      "run-server.py",
    );
    await fs.mkdir(path.dirname(conflict), { recursive: true });
    await fs.writeFile(conflict, "existing");
    await fs.mkdir(path.join(f.toolsRoot, "bin", "lolia"), { recursive: true });
    await fs.writeFile(
      path.join(f.toolsRoot, "bin", "lolia", "current.json"),
      "{}",
    );
    await assert.rejects(
      f.tools.organize(f.instance.id, netRoot, f.ctx),
      /目标已存在/,
    );
    assert.equal(
      await fs.readFile(path.join(f.root, "run-server.py"), "utf8"),
      "original",
    );
    assert.ok(await fs.stat(netRoot));
    assert.equal(
      await fs.readFile(path.join(netRoot, "private", "tunnel-1.toml"), "utf8"),
      'serverAddr="fixture"',
    );
  } finally {
    await f.close();
  }
});

test("工具下载校验失败保留当前安装指针", async (t) => {
  const f = await fixture();
  try {
    const pointer = path.join(f.toolsRoot, "bin", "lolia", "current.json");
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    const previous = '{"version":"0.70.0","executable":"old/frpc.exe"}';
    await fs.writeFile(pointer, previous);
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
      String(url).includes("api.github.com")
        ? new Response(
            JSON.stringify({
              tag_name: "v0.71.4",
              assets: [
                {
                  name: "LoliaFrp_windows_amd64.zip",
                  browser_download_url:
                    "https://github.com/Lolia-FRP/lolia-frp/releases/download/v0.71.4/LoliaFrp_windows_amd64.zip",
                  digest: `sha256:${"0".repeat(64)}`,
                  size: 4,
                },
              ],
            }),
          )
        : new Response("fake"),
    );
    await assert.rejects(f.tools.install("lolia", f.ctx), /校验失败/);
    assert.equal(await fs.readFile(pointer, "utf8"), previous);
    assert.deepEqual(await fs.readdir(path.join(f.toolsRoot, ".staging")), []);
  } finally {
    await f.close();
  }
});

test("通用转接层显式配对不同节点并拒绝自身上游", async () => {
  const f = await fixture();
  try {
    const networkRoot = await f.tools.prepareNetwork(f.instance.id);
    await fs.writeFile(
      path.join(networkRoot, "tunnel-summary.json"),
      JSON.stringify([
        {
          id: 11,
          node: "节点 A",
          proxies: [
            {
              type: "https",
              localPort: 29431,
              customDomains: ["mc.example.com"],
            },
          ],
        },
        {
          id: 22,
          node: "节点 B",
          proxies: [{ type: "udp", localPort: 29431, remotePort: 31000 }],
        },
        {
          id: 33,
          node: "节点 C",
          proxies: [
            {
              type: "https",
              localPort: 29431,
              customDomains: ["backup.example.com"],
            },
          ],
        },
      ]),
    );
    const network = new Network(f.store, f.runtime, "resources", f.toolsRoot);
    const config = {
      key: "route-a",
      name: "备用线路",
      signalId: 11,
      udpId: 22,
      enabled: true,
      listenIP: "127.0.0.1",
      listenPort: 29300,
      upstream: "http://127.0.0.1:29431",
      sourceUdpIP: "8.8.8.8",
      sourceUdpPort: 30000,
      publicUdpIP: "1.1.1.1",
      publicUdpPort: 31000,
      relayOnly: true,
    };
    await network.saveRouter(f.instance.id, config);
    const data = await network.get(f.instance.id);
    assert.equal(data.routes[0].udpId, 22);
    assert.equal(data.routes[0].name, "备用线路");
    assert.equal(data.routes[0].signalingTarget, "127.0.0.1:29300");
    assert.equal(
      (await json<any>(path.join(networkRoot, "client-overrides.json"), {}))[11]
        .httpTargetPort,
      29300,
    );
    await assert.rejects(
      network.saveRouter(f.instance.id, {
        ...config,
        upstream: "http://example.com:19132",
      }),
      /本机回环/,
    );
    await network.saveRouter(f.instance.id, { ...config, signalId: 33 });
    const overrides = await json<any>(
      path.join(networkRoot, "client-overrides.json"),
      {},
    );
    assert.equal(overrides[11].httpTargetPort, 29431);
    assert.equal(overrides[33].httpTargetPort, 29300);
    const rebound = await network.get(f.instance.id);
    assert.equal(rebound.routes.find((r) => r.signalId === 11)?.router, false);
    assert.equal(rebound.routes.find((r) => r.signalId === 33)?.udpId, 22);
  } finally {
    await f.close();
  }
});
