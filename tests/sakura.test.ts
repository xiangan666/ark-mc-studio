import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  applySakuraOverrides,
  parseSakuraIni,
  sakuraSummary,
  writeSakuraIni,
} from "../src/agent/sakura";
import {
  Network,
  tunnelConfigPath,
  resolveUdpIPv4,
} from "../src/agent/network";
import { Runtime } from "../src/agent/runtime";
import { Store } from "../src/agent/store";
import { Tools, latestTool } from "../src/agent/tools";
import { redact } from "../src/agent/safe";

const ini = `[common]\nserver_addr = mc.example.nyat.app\nserver_port = 8088\nuser = fixture-user\ntoken = fixture-secret\nsakura_mode = true\n[game]\ntype = tcp\nlocal_ip = 127.0.0.1\nlocal_port = 19132\nremote_port = 23607\nauto_https = auto\nauto_https_mode = https\n`;

test("公网握手直接使用数字 UDP 地址，凭证脱敏覆盖 Bearer 认证", async () => {
  assert.equal(await resolveUdpIPv4("192.0.2.35"), "192.0.2.35");
  assert.equal(await resolveUdpIPv4("198.51.100.20"), "198.51.100.20");
  assert(
    !redact("Authorization: Bearer fixture-secret-123").includes(
      "fixture-secret-123",
    ),
  );
});

test("樱花 INI 保留私有认证，独立覆写 HTTP 目标且只导出脱敏摘要", () => {
  const document = applySakuraOverrides(parseSakuraIni(ini), {
    httpTargetPort: 19332,
  });
  assert.equal(document.game.local_port, "19332");
  assert.equal(document.game.auto_https_mode, "http");
  const serialized = writeSakuraIni(document);
  assert.equal(parseSakuraIni(serialized).common.token, "fixture-secret");
  assert.equal(parseSakuraIni(serialized).common.user, "fixture-user");
  const summary = sakuraSummary(29756112, document, 217);
  assert(!JSON.stringify(summary).includes("fixture-secret"));
  assert(!JSON.stringify(summary).includes("fixture-user"));
  assert.equal(summary.proxies[0].remotePort, 23607);
  assert.equal(summary.proxies[0].pluginLocalAddr, "127.0.0.1:19332");
  assert(!redact(serialized).includes("fixture-secret"));
  assert(!redact(serialized).includes("fixture-user"));
  assert.throws(() => parseSakuraIni(ini + "[other]\ntype=udp"), /一次导入/);
  assert.throws(() => parseSakuraIni(ini + "type=udp"), /重复参数/);
  assert.throws(
    () =>
      applySakuraOverrides(
        parseSakuraIni(ini.replace("auto_https = auto", "auto_https =")),
      ),
    /自动 HTTPS/,
  );
  const udp = parseSakuraIni(ini.replace("type = tcp", "type = udp"));
  applySakuraOverrides(udp, {
    udpLocalIP: "192.168.1.144",
    httpTargetPort: 19332,
  });
  assert.equal(udp.game.local_port, "19132");
  assert.equal(udp.game.local_ip, "192.168.1.144");
});

test("国内、日本与樱花三组线路保持独立 UDP 配对及真实 HTTPS 端口", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-three-routes-"));
  const store = new Store(path.join(temp, "data"));
  const runtime = new Runtime(store, () => {}, path.resolve("resources"));
  const root = path.join(temp, "核心");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "bedrock_server.exe"), "fixture");
  await fs.writeFile(
    path.join(root, "server.properties"),
    "server-port=29431\nlevel-name=共用世界\n",
  );
  const instance = await runtime.import(root);
  const toolsRoot = path.join(temp, "managed-tools");
  const tools = new Tools(store, runtime, path.resolve("resources"), toolsRoot);
  try {
    const networkRoot = await tools.prepareNetwork(instance.id);
    const entries = [
      {
        id: 11,
        node: "国内",
        serverAddr: "203.0.113.1",
        proxies: [
          {
            type: "https",
            localPort: 29431,
            customDomains: ["domestic.example.com"],
          },
        ],
      },
      {
        id: 12,
        node: "国内",
        serverAddr: "203.0.113.1",
        proxies: [{ type: "udp", localPort: 29431, remotePort: 34051 }],
      },
      {
        id: 21,
        node: "日本",
        proxies: [
          {
            type: "https",
            localPort: 29431,
            customDomains: ["japan.example.com"],
          },
        ],
      },
      {
        id: 22,
        node: "日本",
        serverAddr: "203.0.113.2",
        proxies: [{ type: "udp", localPort: 29431, remotePort: 32592 }],
      },
      sakuraSummary(31, applySakuraOverrides(parseSakuraIni(ini)), 217),
      sakuraSummary(
        32,
        applySakuraOverrides(
          parseSakuraIni(
            ini
              .replace("type = tcp", "type = udp")
              .replace("remote_port = 23607", "remote_port = 23559"),
          ),
        ),
        217,
      ),
    ];
    await fs.writeFile(
      path.join(networkRoot, "tunnel-summary.json"),
      JSON.stringify(entries),
    );
    runtime.processes = entries.map((entry, index) => ({
      pid: 1000 + index,
      ppid: 1,
      name: "frpc.exe",
      path: "fixture",
      command: `frpc -c "${tunnelConfigPath(networkRoot, entry)}"`,
      createdAt: Date.now(),
      memory: 0,
      cpuTime: 0,
    }));
    const network = new Network(
      store,
      runtime,
      path.resolve("resources"),
      toolsRoot,
    );
    const routers = [
      {
        key: "domestic-xian",
        name: "国内-西安电信-1",
        signalId: 11,
        udpId: 12,
        listenPort: 29432,
        publicUdpIP: "203.0.113.1",
        publicUdpPort: 34051,
      },
      {
        key: "japan",
        name: "日本",
        signalId: 21,
        udpId: 22,
        listenPort: 29232,
        publicUdpIP: "203.0.113.2",
        publicUdpPort: 32592,
      },
      {
        key: "sakura",
        name: "樱花",
        signalId: 31,
        udpId: 32,
        listenPort: 29332,
        publicUdpIP: "203.0.113.3",
        publicUdpPort: 23559,
      },
    ].map((r) => ({
      ...r,
      enabled: true,
      listenIP: "127.0.0.1",
      upstream: "http://127.0.0.1:29431",
      sourceUdpIP: "203.0.113.1",
      sourceUdpPort: 34051,
      relayOnly: true,
    }));
    await fs.writeFile(
      path.join(networkRoot, "signal-routers.json"),
      JSON.stringify(routers),
    );
    const result = await network.get(instance.id);
    assert.equal(result.tunnels.filter((t) => t.running).length, 6);
    assert.deepEqual(
      result.routes.map((r) => [r.signalId, r.udpId, r.port, r.protocol]),
      [
        [11, 12, 443, "https"],
        [21, 22, 443, "https"],
        [31, 32, 23607, "https"],
      ],
    );
    assert.equal(result.routes[0].router, true);
    assert.equal(result.routes[0].signalingTarget, "127.0.0.1:29432");
    assert.equal(result.routes[0].udpHost, "203.0.113.1");
    assert.equal(result.routes[0].udpPort, 34051);
    assert.equal(result.routes[2].udpHost, "203.0.113.3");
    assert.equal(result.routes[2].signalingTarget, "127.0.0.1:29332");
    runtime.processes = [];
    await network.saveRouter(instance.id, routers[1]);
    const live = await network.get(instance.id);
    assert.equal(live.routes[0].udpId, 12);
    assert.equal(live.routes[1].udpId, 22);
    assert.equal(live.routes[2].udpId, 32);
    const core = await fs.readFile(
      path.join(root, "server.properties"),
      "utf8",
    );
    assert.equal(core, "server-port=29431\nlevel-name=共用世界\n");
    await assert.rejects(
      network.import(
        instance.id,
        11,
        "fixturetoken12345",
        {
          id: randomUUID(),
          signal: new AbortController().signal,
          update: () => {},
        },
        "sakura",
      ),
      /另一服务商/,
    );
  } finally {
    runtime.dispose();
    store.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("樱花更新核对官方 EXE 的长度和 MD5，校验失败保留旧指针", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-sakura-update-"));
  const store = new Store(path.join(temp, "data"));
  const runtime = new Runtime(store, () => {}, path.resolve("resources"));
  const toolsRoot = path.join(temp, "managed-tools");
  const tools = new Tools(store, runtime, path.resolve("resources"), toolsRoot);
  const metadata = {
    frpc: {
      ver: "0.51.0-sakura-15.1",
      archs: {
        windows_amd64: {
          url: "https://nya.globalslb.net/natfrp/client/frpc/0.51.0-sakura-15.1/frpc_windows_amd64.exe",
          hash: "0".repeat(32),
          size: 4,
        },
      },
    },
  };
  try {
    const pointer = path.join(toolsRoot, "bin", "sakura", "current.json");
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    const previous = '{"version":"previous","executable":"old/frpc.exe"}';
    await fs.writeFile(pointer, previous);
    t.mock.method(globalThis, "fetch", async (url: any) =>
      String(url).includes("api.natfrp.com")
        ? new Response(JSON.stringify(metadata))
        : new Response("bad!"),
    );
    const release = await latestTool("sakura");
    assert.equal(release.algorithm, "md5");
    assert.equal(release.format, "exe");
    await assert.rejects(
      tools.install("sakura", {
        id: randomUUID(),
        signal: new AbortController().signal,
        update: () => {},
      }),
      /MD5 校验失败/,
    );
    assert.equal(await fs.readFile(pointer, "utf8"), previous);
    metadata.frpc.archs.windows_amd64.url =
      "https://unrelated.example/frpc.exe";
    await assert.rejects(latestTool("sakura"), /来源/);
  } finally {
    runtime.dispose();
    store.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
