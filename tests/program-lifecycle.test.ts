import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProgramLifecycle } from "../src/main/program-lifecycle";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ark-lifecycle-"));
  const id = randomUUID(),
    inactive = randomUUID();
  const calls: string[] = [];
  const state: any = {
    agentVersion: "1.3.0",
    samplerReady: true,
    jobs: [],
    instances: [
      { id, name: "活动实例", root: "C:/fixture/server" },
      { id: inactive, name: "停止实例", root: "C:/fixture/stopped" },
    ],
    snapshots: [
      {
        id,
        pid: 123,
        status: "running",
        capabilities: { command: true, sessionHost: true },
      },
      {
        id: inactive,
        pid: null,
        status: "stopped",
        capabilities: { command: true },
      },
    ],
  };
  let directRunning = true;
  const tunnels = [
    { id: 850, running: true, type: "udp" },
    { id: 850, running: true, type: "tcp" },
  ];
  const job = (detail: string) => {
    const j = { id: randomUUID(), status: "success", detail };
    state.jobs.push(j);
    return j;
  };
  const agent: any = {
    call: async (method: string, args: any = {}) => {
      if (method === "bootstrap") return structuredClone(state);
      if (method === "tunnels.get")
        return { tunnels: args.id === id ? tunnels : [], routers: [] };
      if (method === "server.action") {
        calls.push(`server:${args.action}:${args.id}`);
        state.snapshots.find((s: any) => s.id === args.id).pid =
          args.action === "stop" ? null : 456;
        return job("done");
      }
      throw new Error(method);
    },
    reloadPreservingSessions: async () => {
      calls.push("backend:reload");
      state.agentVersion = "1.4.0";
      return structuredClone(state);
    },
    stopWhenIdle: async () => {
      calls.push("backend:stop");
    },
  };
  const direct: any = {
    get: async (value: string) => ({ running: value === id && directRunning }),
    action: async (_id: string, action: string) => {
      calls.push(`direct:${action}`);
      directRunning = action === "start";
    },
  };
  const network: any = {
    call: async (_method: string, args: any) => {
      calls.push(`tunnel:${args.action}:${args.tunnelId || "all"}`);
      for (const t of tunnels) t.running = args.action !== "stop";
      return job("done");
    },
  };
  const lifecycle = new ProgramLifecycle(
    agent,
    direct,
    network,
    root,
    "1.4.0",
    async () => {
      calls.push("workspace:cleanup");
    },
  );
  return {
    root,
    id,
    inactive,
    state,
    calls,
    lifecycle,
    close: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("在线更新立即更换管理服务，不停止或重启服务器与线路，控制能力保持", async () => {
  const f = await fixture();
  try {
    assert.equal(f.lifecycle.status.phase, "idle");
    assert.equal(f.calls.length, 0, "构造或读取状态不能自动停服");
    assert.equal(f.lifecycle.startUpgrade().phase, "running");
    while (f.lifecycle.busy) await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.lifecycle.status.phase, "complete");
    assert.deepEqual(f.calls, ["backend:reload", "workspace:cleanup"]);
    assert.equal(f.state.snapshots[0].pid, 123);
    assert.equal(f.lifecycle.acceptsService("1.3.0"), false);
    assert.equal(f.lifecycle.acceptsService("1.2.0"), false);
    assert(!f.calls.some((c) => c.includes(f.inactive)));
  } finally {
    await f.close();
  }
});

test("托盘完整退出停止所有托管服务和后台，不恢复服务器", async () => {
  const f = await fixture();
  try {
    await f.lifecycle.quit();
    assert.equal(f.lifecycle.status.phase, "complete");
    assert.deepEqual(f.calls, [
      `server:stop:${f.id}`,
      "direct:stop",
      "tunnel:stop:all",
      "backend:stop",
    ]);
  } finally {
    await f.close();
  }
});

test("任务繁忙阻止更新；不可控服务器阻止完整退出，失败原因不会残留", async () => {
  const f = await fixture();
  try {
    f.state.jobs.push({ id: randomUUID(), status: "running" });
    f.lifecycle.startUpgrade();
    while (f.lifecycle.busy) await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.lifecycle.status.phase, "failed");
    assert.equal(f.calls.length, 0);
    f.state.jobs = [];
    f.state.snapshots[0].capabilities.command = false;
    await assert.rejects(f.lifecycle.quit(), /安全控制/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
