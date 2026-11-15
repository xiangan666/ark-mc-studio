import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentClient } from "../src/main/agent-client";
import { backendReloadBlock } from "../src/shared/backend";

test("在线更换管理服务只允许可验证的独立会话，旧式控制台保持原样并拒绝替换", () => {
  const state: any = {
    instances: [{ id: "fixture", adapter: "managed" }],
    snapshots: [
      {
        id: "fixture",
        status: "running",
        pid: 123,
        capabilities: { command: true, sessionHost: true },
      },
    ],
    samplerReady: true,
    jobs: [],
  };
  assert.equal(backendReloadBlock(state, true), "");
  assert.match(backendReloadBlock(state, false), /正常关闭/);
  state.snapshots[0].capabilities.sessionHost = false;
  assert.match(backendReloadBlock(state, true), /手动完成首次版本切换/);
  state.snapshots[0].capabilities.sessionHost = true;
  state.snapshots[0].capabilities.command = false;
  assert.match(backendReloadBlock(state, true), /未执行任何停服/);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-backend-"));
  const clients: AgentClient[] = [];
  const script = (version: string) => `
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), readline = require('node:readline'), crypto = require('node:crypto');
const root = process.argv[process.argv.indexOf('--data') + 1];
const filename = path.join(root, '.agent-auth.json');
const previous = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
const pipe = process.platform === 'win32' ? '\\\\\\\\.\\\\pipe\\\\arkmc-test-' + crypto.createHash('sha256').update(root).digest('hex').slice(0, 16) : path.join(root, 'agent.sock');
const token = previous?.token || crypto.randomBytes(32).toString('hex');
fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, token, pipe }));
const server = net.createServer(socket => {
  readline.createInterface({ input: socket }).on('line', line => {
    const request = JSON.parse(line);
    if (request.token !== token) return socket.destroy();
    const data = { agentVersion: '${version}', instances: [], snapshots: [], jobs: [], samplerReady: true, ...JSON.parse(fs.readFileSync(path.join(root, 'bootstrap.json'), 'utf8')) };
    socket.write(JSON.stringify({ id: request.id, ok: true, data }) + '\\n');
  });
  socket.on('error', () => {});
});
server.listen(pipe, () => fs.writeFileSync(path.join(root, '.agent-state.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: '${version}' })));
process.on('SIGTERM', () => process.exit(0));
`;
  await fs.writeFile(path.join(root, "bootstrap.json"), "{}");
  for (const version of ["1.1.2", "1.1.3"])
    await fs.writeFile(path.join(root, `${version}.cjs`), script(version));
  function client(version: string) {
    const value = new AgentClient(
      root,
      path.join(root, `${version}.cjs`),
      process.execPath,
      root,
    );
    clients.push(value);
    return value;
  }
  return {
    root,
    client,
    async snapshot(value: any) {
      await fs.writeFile(
        path.join(root, "bootstrap.json"),
        JSON.stringify(value),
      );
    },
    async pid() {
      return JSON.parse(
        await fs.readFile(path.join(root, ".agent-state.json"), "utf8"),
      ).pid as number;
    },
    async close() {
      for (const value of clients) value.disconnect();
      try {
        const state = JSON.parse(
          await fs.readFile(path.join(root, ".agent-state.json"), "utf8"),
        );
        process.kill(state.pid);
      } catch {}
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("新版界面安全重载空闲旧后台，重新连接新版并保留数据目录", async () => {
  const f = await fixture();
  try {
    const old = f.client("1.1.2");
    assert.equal((await old.call<any>("bootstrap")).agentVersion, "1.1.2");
    const before = await f.pid();
    const current = f.client("1.1.3");
    assert.equal((await current.call<any>("bootstrap")).agentVersion, "1.1.2");
    const next = await current.reloadWhenIdle();
    assert.equal(next.agentVersion, "1.1.3");
    assert.notEqual(await f.pid(), before);
    assert.equal((await current.call<any>("bootstrap")).agentVersion, "1.1.3");
    assert.equal(
      await fs.readFile(path.join(f.root, "bootstrap.json"), "utf8"),
      "{}",
    );
  } finally {
    await f.close();
  }
});

test("服务器运行、状态未确认或维护任务繁忙时拒绝重载，保持旧后台连接", async () => {
  const f = await fixture();
  try {
    const current = f.client("1.1.2");
    await current.call("bootstrap");
    const before = await f.pid();
    const instance = { id: "fixture" };
    for (const state of [
      {
        instances: [instance],
        snapshots: [{ id: "fixture", status: "running", pid: 1234 }],
      },
      {
        instances: [instance],
        snapshots: [{ id: "fixture", status: "starting", pid: null }],
      },
      { instances: [instance], snapshots: [] },
      { instances: [instance], samplerReady: false },
      { jobs: [{ status: "running" }] },
      { jobs: [{ status: "queued" }] },
    ]) {
      await f.snapshot(state);
      await assert.rejects(
        current.reloadWhenIdle(),
        /请先正常关闭|采样尚未就绪|等待后台任务/,
      );
      assert.equal(await f.pid(), before);
      assert.equal(
        (await current.call<any>("bootstrap")).agentVersion,
        "1.1.2",
      );
    }
  } finally {
    await f.close();
  }
});
