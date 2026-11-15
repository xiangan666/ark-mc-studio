import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyTunnelOverrides } from "../src/agent/network";
import { resolveTunnelClient } from "../src/agent/tunnel-clients";
import {
  tunnelClients,
  uniqueTunnelClients,
  routerConfigError,
} from "../src/shared/network";
import { upgradeWorkspace } from "../src/main/workspace-upgrade";
import type { ProcessInfo, SignalRouterConfig } from "../src/shared/types";

test("云 FRP 统一识别官方客户端，缺失时不回退到 Lolia", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ark-clients-"));
  try {
    assert.equal(tunnelClients["frp-panel"].tool, "frp");
    await fs.mkdir(path.join(root, "bin/lolia"), { recursive: true });
    await fs.writeFile(path.join(root, "bin/lolia/frpc.exe"), "lolia fixture");
    await fs.writeFile(
      path.join(root, "bin/lolia/current.json"),
      JSON.stringify({ executable: "bin/lolia/frpc.exe" }),
    );
    assert.equal((await resolveTunnelClient(root, "frp-panel")).ready, false);
    await fs.mkdir(path.join(root, "bin/frp"), { recursive: true });
    await fs.writeFile(path.join(root, "bin/frp/frpc.exe"), "official fixture");
    await fs.writeFile(
      path.join(root, "bin/frp/current.json"),
      JSON.stringify({ executable: "bin/frp/frpc.exe", version: "0.65.0" }),
    );
    const client = await resolveTunnelClient(root, "frp-panel");
    assert.equal(client.ready, true);
    assert.equal(client.executable, path.join(root, "bin/frp/frpc.exe"));
    await fs.writeFile(
      path.join(root, "bin/frp/current.json"),
      JSON.stringify({ executable: "../outside.exe" }),
    );
    assert.equal((await resolveTunnelClient(root, "frp-panel")).ready, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("一份云 FRP TCP/UDP 配置只启动一个客户端，保留认证与 UDP 目标", () => {
  const config = {
    auth: { method: "token", token: "fixture-secret" },
    proxies: [
      {
        name: "game",
        type: "udp",
        localIP: "192.168.1.20",
        localPort: 19132,
        remotePort: 19132,
      },
      {
        name: "signal",
        type: "tcp",
        localIP: "127.0.0.1",
        localPort: 19132,
        remotePort: 19133,
      },
    ],
  };
  const result = applyTunnelOverrides(
    config,
    "C:/private",
    { httpTargetPort: 19532 },
    "frp-panel",
  );
  assert.equal(result.proxies[0].localPort, 19132);
  assert.equal(result.proxies[1].localPort, 19532);
  assert.equal(result.proxies[1].remotePort, 19133);
  assert.equal(result.auth.token, "fixture-secret");
  assert.equal(
    uniqueTunnelClients([
      { id: 850, provider: "frp-panel" as const },
      { id: 850, provider: "frp-panel" as const },
    ]).length,
    1,
  );
  assert.throws(() => applyTunnelOverrides(config, "C:/private"), /信令或 UDP/);
});

test("统一转接配置拒绝回环自指、远端上游、越界端口与无效映射", () => {
  const config: SignalRouterConfig = {
    key: "route-1",
    name: "线路",
    signalId: 1,
    udpId: 2,
    enabled: true,
    listenIP: "127.0.0.1",
    listenPort: 19532,
    upstream: "http://127.0.0.1:19132",
    sourceUdpIP: "192.0.2.1",
    sourceUdpPort: 19132,
    publicUdpIP: "192.0.2.2",
    publicUdpPort: 19133,
    relayOnly: true,
  };
  assert.equal(routerConfigError(config), "");
  for (const change of [
    { upstream: "http://example.com:19132" },
    { upstream: "http://localhost:19532" },
    { publicUdpIP: "999.1.1.1" },
    { publicUdpPort: 0 },
    { listenPort: 65536 },
  ])
    assert(routerConfigError({ ...config, ...change }));
});

test("启动整理幂等：保留活动运行时、当前版和回退版，清理已知旧副本并迁移登记别名", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ark-upgrade-"));
  try {
    const names = [
      "1.0.0-1111111111111111",
      "1.1.0-2222222222222222",
      "1.2.0-3333333333333333",
      "1.4.0-4444444444444444",
    ];
    for (let i = 0; i < names.length; i++) {
      const dir = path.join(root, "desktop-host", names[i]);
      await fs.mkdir(path.join(dir, "agent"), { recursive: true });
      await fs.writeFile(path.join(dir, ".ready"), "1");
      await fs.writeFile(path.join(dir, "agent/agent.cjs"), "fixture");
      await fs.utimes(
        dir,
        new Date(100000 + i * 10000),
        new Date(100000 + i * 10000),
      );
    }
    await fs.mkdir(path.join(root, "bin/frp-panel"), { recursive: true });
    await fs.writeFile(path.join(root, "bin/frp-panel/frpc.exe"), "fixture");
    await fs.writeFile(
      path.join(root, "bin/frp-panel/current.json"),
      JSON.stringify({
        executable: "bin/frp-panel/frpc.exe",
        version: "0.65.0",
      }),
    );
    const options = {
      toolsRoot: root,
      currentResources: path.join(root, "desktop-host", names[3]),
      version: "1.4.0",
      state: { instances: [], jobs: [] },
      processes: [
        {
          path: path.join(root, "desktop-host", names[1], "node.exe"),
        } as ProcessInfo,
      ],
    };
    const first = await upgradeWorkspace(options);
    assert.equal(first.status, "complete");
    assert(first.removedBytes > 0);
    assert.equal((await resolveTunnelClient(root, "frp-panel")).ready, true);
    await assert.rejects(fs.access(path.join(root, "desktop-host", names[0])));
    for (const name of names.slice(1))
      await fs.access(path.join(root, "desktop-host", name));
    const second = await upgradeWorkspace(options);
    assert.equal(second.removedBytes, 0);
    assert.equal(second.changes.length, 0);
    assert.equal(first.retained.length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
