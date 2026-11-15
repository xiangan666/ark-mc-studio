import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/agent/store";
import { Runtime } from "../src/agent/runtime";
import { Content } from "../src/agent/content";
import { Backups } from "../src/agent/backups";
import { Jobs, type JobContext } from "../src/agent/jobs";
import { API } from "../src/agent/api";
import { sleep } from "../src/agent/safe";
import { Installer, assertPortsAvailable } from "../src/agent/install";
import { applyTunnelOverrides } from "../src/agent/network";
import net from "node:net";
import dgram from "node:dgram";
import type { Instance, AgentEvent, Job } from "../src/shared/types";

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-data-"));
  const root = path.join(temp, "中文服务器");
  await fs.mkdir(path.join(root, "worlds", "测试世界", "db"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "bedrock_server.exe"),
    "mock, never launched",
  );
  await fs.writeFile(
    path.join(root, "server.properties"),
    "# 中文注释\r\nserver-name=测试世界\r\nlevel-name=测试世界\r\nserver-port=29432\r\nmax-players=20\r\ngamemode=survival\r\n",
  );
  await fs.writeFile(
    path.join(root, "worlds", "测试世界", "level.dat"),
    "original-level",
  );
  await fs.writeFile(
    path.join(root, "worlds", "测试世界", "db", "CURRENT"),
    "original-database",
  );
  const store = new Store(path.join(temp, "app"));
  const events: AgentEvent[] = [];
  const runtime = new Runtime(
    store,
    (event) => events.push(event),
    path.resolve("resources"),
  );
  runtime.samplerReady = true;
  const i = await runtime.import(root);
  const content = new Content(store, runtime);
  const backups = new Backups(store, runtime);
  const ctx: JobContext = {
    id: randomUUID(),
    signal: new AbortController().signal,
    update: () => {},
  };
  return {
    temp,
    root,
    store,
    runtime,
    i,
    content,
    backups,
    ctx,
    events,
    async cleanup() {
      runtime.dispose();
      store.close();
      await fs.rm(temp, { recursive: true, force: true });
    },
  };
}
test("配置编辑检测外部修改并保留原文件", async () => {
  const f = await fixture();
  try {
    const config = await f.content.config(f.i.id);
    await fs.appendFile(
      path.join(f.root, "server.properties"),
      "external=true\r\n",
    );
    await assert.rejects(
      f.content.saveConfig(f.i.id, { "max-players": "30" }, config.revision),
      /变更|修改/,
    );
    assert.match(
      await fs.readFile(path.join(f.root, "server.properties"), "utf8"),
      /external=true/,
    );
  } finally {
    await f.cleanup();
  }
});
test("文本配置保存有历史副本且拒绝破损 JSON", async () => {
  const f = await fixture();
  try {
    const config = await f.content.config(f.i.id);
    await f.content.saveConfig(
      f.i.id,
      { "max-players": "30" },
      config.revision,
    );
    const history = await fs.readdir(
      path.join(f.store.root, "config-history", f.i.id),
    );
    assert.equal(history.length, 1);
    assert.match(
      await fs.readFile(path.join(f.root, "server.properties"), "utf8"),
      /# 中文注释/,
    );
    await fs.writeFile(path.join(f.root, "allowlist.json"), "[]");
    const allow = await f.content.read(f.i.id, "allowlist.json");
    await assert.rejects(
      f.content.write(f.i.id, "allowlist.json", "{invalid}", allow.revision),
    );
    assert.equal(
      await fs.readFile(path.join(f.root, "allowlist.json"), "utf8"),
      "[]",
    );
  } finally {
    await f.cleanup();
  }
});
test("运行中取消资源包时递归取消依赖包引用，保留文件并标记待重启", async () => {
  const f = await fixture();
  try {
    const resourceId = "11111111-1111-4111-8111-111111111111";
    const behaviorId = "22222222-2222-4222-8222-222222222222";
    const unusedId = "33333333-3333-4333-8333-333333333333";
    const resourcePath = path.join(f.root, "resource_packs", resourceId);
    const behaviorPath = path.join(f.root, "behavior_packs", behaviorId);
    const unusedPath = path.join(f.root, "behavior_packs", unusedId);
    await fs.mkdir(resourcePath, { recursive: true });
    await fs.mkdir(behaviorPath, { recursive: true });
    await fs.mkdir(unusedPath, { recursive: true });
    await fs.writeFile(
      path.join(resourcePath, "manifest.json"),
      JSON.stringify({
        header: { uuid: resourceId, name: "Test RP", version: [1, 0, 0] },
        modules: [
          { type: "resources", uuid: randomUUID(), version: [1, 0, 0] },
        ],
        dependencies: [],
      }),
    );
    await fs.writeFile(
      path.join(behaviorPath, "manifest.json"),
      JSON.stringify({
        header: { uuid: behaviorId, name: "Test BP", version: [1, 0, 0] },
        modules: [{ type: "data", uuid: randomUUID(), version: [1, 0, 0] }],
        dependencies: [{ uuid: resourceId, version: [1, 0, 0] }],
      }),
    );
    await fs.writeFile(
      path.join(unusedPath, "manifest.json"),
      JSON.stringify({
        header: { uuid: unusedId, name: "Independent BP", version: [1, 0, 0] },
        modules: [{ type: "data", uuid: randomUUID(), version: [1, 0, 0] }],
        dependencies: [],
      }),
    );
    const behaviorRefs = path.join(
      f.root,
      "worlds",
      "测试世界",
      "world_behavior_packs.json",
    );
    const resourceRefs = path.join(
      f.root,
      "worlds",
      "测试世界",
      "world_resource_packs.json",
    );
    await fs.writeFile(
      behaviorRefs,
      JSON.stringify([
        { pack_id: behaviorId, version: [1, 0, 0] },
        { pack_id: unusedId, version: [1, 0, 0] },
      ]),
    );
    await fs.writeFile(
      resourceRefs,
      JSON.stringify([{ pack_id: resourceId, version: [1, 0, 0] }]),
    );
    const snapshot = await f.runtime.get(f.i.id);
    let stopCalls = 0;
    (f.runtime as any).get = async () => ({
      ...snapshot,
      status: "running",
      pid: 9923,
    });
    (f.runtime as any).stop = async () => {
      stopCalls++;
      throw new Error("server must not be stopped");
    };

    const result = await f.content.togglePack(f.i.id, resourceId, false);
    assert.deepEqual(result, {
      disabled: ["Test BP", "Test RP"],
      pendingRestart: true,
    });
    assert.deepEqual(JSON.parse(await fs.readFile(behaviorRefs, "utf8")), [
      { pack_id: unusedId, version: [1, 0, 0] },
    ]);
    assert.deepEqual(JSON.parse(await fs.readFile(resourceRefs, "utf8")), []);
    assert.equal(
      await fs
        .readFile(path.join(resourcePath, "manifest.json"), "utf8")
        .then((value) => value.includes(resourceId)),
      true,
    );
    assert.equal(
      await fs.stat(path.join(behaviorPath, "manifest.json")).then(() => true),
      true,
    );
    assert.equal(
      await fs.stat(path.join(unusedPath, "manifest.json")).then(() => true),
      true,
    );
    assert.equal(stopCalls, 0);
  } finally {
    await f.cleanup();
  }
});
test("运行中阻止启用新包和切换 Endstone 插件", async () => {
  const f = await fixture();
  try {
    const resourceId = "44444444-4444-4444-8444-444444444444";
    const packPath = path.join(f.root, "resource_packs", resourceId);
    await fs.mkdir(packPath, { recursive: true });
    await fs.writeFile(
      path.join(packPath, "manifest.json"),
      JSON.stringify({
        header: { uuid: resourceId, name: "Disabled RP", version: [1, 0, 0] },
        modules: [
          { type: "resources", uuid: randomUUID(), version: [1, 0, 0] },
        ],
        dependencies: [],
      }),
    );
    const pluginPath = path.join(f.root, "plugins", "test-plugin.disabled");
    await fs.mkdir(pluginPath, { recursive: true });
    const snapshot = await f.runtime.get(f.i.id);
    (f.runtime as any).get = async () => ({
      ...snapshot,
      status: "running",
      pid: 9923,
    });
    await assert.rejects(
      f.content.togglePack(f.i.id, resourceId, true),
      /运行中不能启用/,
    );
    await assert.rejects(
      f.content.togglePack(f.i.id, "plugin:test-plugin.disabled", true),
      /插件需在服务器停止后/,
    );
    assert.equal(await fs.stat(pluginPath).then(() => true), true);
  } finally {
    await f.cleanup();
  }
});
test("世界备份、清单校验、修改后恢复与保护快照", async () => {
  const f = await fixture();
  try {
    const backup = await f.backups.create(f.i.id, "world", f.ctx);
    assert.equal(backup.verified, true);
    assert.equal(backup.files, 2);
    assert.equal((await f.backups.manifest(backup.id)).files.length, 2);
    await f.backups.verify(backup.id, f.ctx);
    await fs.writeFile(
      path.join(f.root, "worlds", "测试世界", "db", "CURRENT"),
      "changed",
    );
    await f.backups.restore(backup.id, f.ctx);
    assert.equal(
      await fs.readFile(
        path.join(f.root, "worlds", "测试世界", "db", "CURRENT"),
        "utf8",
      ),
      "original-database",
    );
    assert(f.store.backups().some((b) => b.kind === "full"));
    assert(
      !(await fs.readdir(f.root)).some((n) => n.startsWith(".ark-restore-")),
    );
  } finally {
    await f.cleanup();
  }
});
test("完整快照恢复会移除快照之后新增的核心文件", async () => {
  const f = await fixture();
  try {
    const backup = await f.backups.create(f.i.id, "full", f.ctx);
    await fs.writeFile(
      path.join(f.root, "new-binary.dll"),
      "unexpected-new-version",
    );
    await fs.writeFile(
      path.join(f.root, "bedrock_server.exe"),
      "changed-version",
    );
    await f.backups.restore(backup.id, f.ctx);
    await assert.rejects(fs.stat(path.join(f.root, "new-binary.dll")));
    assert.equal(
      await fs.readFile(path.join(f.root, "bedrock_server.exe"), "utf8"),
      "mock, never launched",
    );
  } finally {
    await f.cleanup();
  }
});
test("损坏备份被阻止，不修改活动世界", async () => {
  const f = await fixture();
  try {
    const backup = await f.backups.create(f.i.id, "world", f.ctx);
    await fs.appendFile(f.backups.exportPath(backup.id), "corrupt");
    await assert.rejects(f.backups.restore(backup.id, f.ctx), /损坏/);
    assert.equal(
      await fs.readFile(
        path.join(f.root, "worlds", "测试世界", "db", "CURRENT"),
        "utf8",
      ),
      "original-database",
    );
    assert.equal(
      f.store.backups().find((b) => b.id === backup.id)?.verified,
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test("完整恢复重新关联外置 Endstone 环境且不写入核心目录", async () => {
  const f = await fixture();
  try {
    const toolsRoot = path.join(f.temp, "manager", "managed-tools");
    f.store.set("managed-tools-root", toolsRoot);
    const python = path.join(
      toolsRoot,
      "runtimes",
      "endstone",
      "old",
      "Scripts",
      "python.exe",
    );
    const nextPython = path.join(
      toolsRoot,
      "runtimes",
      "endstone",
      "new",
      "Scripts",
      "python.exe",
    );
    for (const file of [python, nextPython]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "fixture, never launched");
    }
    await f.runtime.saveInstance({ ...f.i, core: "endstone", python });
    const backup = await f.backups.create(f.i.id, "full", f.ctx);
    assert.equal(
      (await f.backups.manifest(backup.id)).managedPython,
      path.relative(toolsRoot, python),
    );
    await f.runtime.saveInstance({
      ...f.store.instance(f.i.id),
      python: nextPython,
    });
    await f.backups.restore(backup.id, f.ctx);
    assert.equal(f.store.instance(f.i.id).python, python);
    const record = JSON.parse(
      await fs.readFile(
        path.join(toolsRoot, "instances", f.i.id, "instance.json"),
        "utf8",
      ),
    );
    assert.equal(record.python, python);
    assert.equal(
      await fs.stat(path.join(f.root, ".venv")).catch(() => null),
      null,
    );
    await fs.rename(python, python + ".missing");
    await fs.writeFile(
      path.join(f.root, "worlds", "测试世界", "level.dat"),
      "keep-current-world",
    );
    await assert.rejects(
      f.backups.restore(backup.id, f.ctx),
      /ENOENT|运行环境/,
    );
    assert.equal(
      await fs.readFile(
        path.join(f.root, "worlds", "测试世界", "level.dat"),
        "utf8",
      ),
      "keep-current-world",
    );
  } finally {
    await f.cleanup();
  }
});
test("在线备份失败或取消后仍发送 save resume", async () => {
  const f = await fixture();
  const commands: string[] = [];
  try {
    const snapshot = await f.runtime.get(f.i.id);
    (f.runtime as any).get = async () => ({ ...snapshot, pid: 12345 });
    (f.runtime as any).command = async (_id: string, command: string) => {
      commands.push(command);
    };
    (f.runtime as any).waitLines = async () =>
      `[12:00:00 INFO]: 测试世界/db/MISSING:123`;
    await assert.rejects(f.backups.create(f.i.id, "world", f.ctx));
    assert.deepEqual(commands, ["save hold", "save resume"]);
    assert.equal(f.store.get(`save-hold:${f.i.id}`, null), null);
  } finally {
    await f.cleanup();
  }
});
test("在线备份精确截断已增长的数据库文件", async () => {
  const f = await fixture();
  const commands: string[] = [];
  try {
    const snapshot = await f.runtime.get(f.i.id);
    (f.runtime as any).get = async () => ({ ...snapshot, pid: 123 });
    (f.runtime as any).command = async (_id: string, command: string) =>
      commands.push(command);
    (f.runtime as any).waitLines = async () =>
      `[12:00:00 INFO]: 测试世界/db/CURRENT:8`;
    const backup = await f.backups.create(f.i.id, "world", f.ctx);
    const manifest = await f.backups.manifest(backup.id);
    assert.equal(manifest.files[0].size, 8);
    await f.backups.verify(backup.id, f.ctx);
    assert.deepEqual(commands, ["save hold", "save resume"]);
  } finally {
    await f.cleanup();
  }
});
test("同一实例任务严格串行，不同实例可并行", async () => {
  const f = await fixture();
  try {
    const jobs = new Jobs(f.store, () => {});
    const trace: string[] = [];
    jobs.run(f.i.id, "test", "a", async () => {
      trace.push("a+");
      await sleep(70);
      trace.push("a-");
    });
    jobs.run(f.i.id, "test", "b", async () => {
      trace.push("b+");
      trace.push("b-");
    });
    jobs.run("other", "test", "c", async () => {
      trace.push("c");
      return 1;
    });
    await sleep(200);
    assert(trace.indexOf("a-") < trace.indexOf("b+"));
    assert(trace.indexOf("c") < trace.indexOf("a-"));
    assert.equal(
      f.store.jobs().filter((j) => j.status === "success").length,
      3,
    );
  } finally {
    await f.cleanup();
  }
});
test("排队任务可取消，后台重启将未完成任务标记中断", async () => {
  const f = await fixture();
  try {
    const jobs = new Jobs(f.store, () => {});
    jobs.run(f.i.id, "test", "a", async () => sleep(100));
    const b = jobs.run(f.i.id, "test", "b", async () => {
      throw new Error("must not execute");
    });
    jobs.cancel(b.id);
    await sleep(180);
    assert.equal(
      f.store.jobs().find((j) => j.id === b.id)?.status,
      "cancelled",
    );
    f.store.put("jobs", {
      id: randomUUID(),
      status: "running",
      createdAt: Date.now(),
      instanceId: f.i.id,
      type: "test",
      title: "interrupted",
      progress: 20,
      detail: "working",
    } as Job);
    new Jobs(f.store, () => {});
    assert.equal(
      f.store.jobs().find((j) => j.title === "interrupted")?.status,
      "interrupted",
    );
  } finally {
    await f.cleanup();
  }
});
test("陈旧 PID 和错误进程路径无法接管命令", async () => {
  const f = await fixture();
  try {
    f.i.adapter = "legacy";
    f.store.put("instances", f.i);
    await fs.writeFile(
      path.join(f.root, ".server-state.json"),
      JSON.stringify({ supervisorPid: 888, startedAt: Date.now() / 1000 }),
    );
    f.runtime.processes = [
      {
        pid: 888,
        ppid: 1,
        name: "python.exe",
        path: "C:/python.exe",
        command: "unrelated.py",
        memory: 1,
        cpuTime: 0,
        createdAt: Date.now(),
      },
    ];
    await assert.rejects(f.runtime.command(f.i.id, "stop"), /身份校验/);
  } finally {
    await f.cleanup();
  }
});
test("已有进程阻止重复启动，能力反映外部控制状态", async () => {
  const f = await fixture();
  try {
    f.runtime.processes = [
      {
        pid: 777,
        ppid: 1,
        name: "bedrock_server.exe",
        path: path.join(f.root, "bedrock_server.exe"),
        command: "",
        memory: 100,
        cpuTime: 0,
        createdAt: Date.now(),
      },
    ];
    const snap = await f.runtime.snapshot(f.i, false);
    assert.equal(snap.status, "unmanaged");
    assert.equal(snap.capabilities.command, false);
    await assert.rejects(f.runtime.start(f.i.id), /已经运行/);
    await assert.rejects(f.runtime.stop(f.i.id), /无法安全接管/);
  } finally {
    await f.cleanup();
  }
});
test("IPC 参数校验拒绝未知操作、非法命令及失效实例", async () => {
  const f = await fixture();
  try {
    const api = new API(f.store, () => {}, path.resolve("resources"));
    await assert.rejects(
      api.call("shell.execute", { cmd: "anything" }),
      /不支持/,
    );
    await assert.rejects(
      api.call("console.send", { id: f.i.id, command: "list\nstop" }),
    );
    await assert.rejects(
      api.call("worlds.list", { id: randomUUID() }),
      /不存在/,
    );
    await assert.rejects(
      api.call("schedules.save", {
        instanceId: f.i.id,
        name: "bad",
        cron: "invalid",
        action: "backup",
        enabled: true,
      }),
    );
    const plan = (await api.call("schedules.save", {
      instanceId: f.i.id,
      name: "凌晨备份",
      cron: "0 4 * * *",
      action: "backup",
      enabled: false,
    })) as any;
    assert(plan.nextAt > Date.now());
    assert.equal(plan.enabled, false);
  } finally {
    await f.cleanup();
  }
});

test("重读历史日志不会重复累加玩家时长，后续真实重连继续累计", async () => {
  const f = await fixture();
  try {
    f.i.core = "endstone";
    const text =
      "[12:00:00 INFO]: Player connected: TestPlayer, xuid: 12345\n[12:00:01 INFO]: TestPlayer joined the game\n[12:05:01 INFO]: TestPlayer left the game\n";
    const at = new Date();
    at.setHours(12, 5, 1, 0);
    f.runtime.ingest(f.i, text, true, at.getTime());
    assert.equal(f.store.players(f.i.id)[0].totalSeconds, 300);
    f.runtime.ingest(f.i, text, true, at.getTime());
    assert.equal(f.store.players(f.i.id)[0].totalSeconds, 300);
    f.runtime.ingest(
      f.i,
      "[12:10:01 INFO]: TestPlayer joined the game\n[12:11:01 INFO]: TestPlayer left the game\n",
      true,
      at.getTime(),
    );
    assert.equal(f.store.players(f.i.id)[0].totalSeconds, 360);
  } finally {
    await f.cleanup();
  }
});

test("安装前分别发现 TCP 和 UDP 端口占用", async () => {
  const tcp = net.createServer();
  await new Promise<void>((resolve) => tcp.listen(0, "0.0.0.0", resolve));
  const port = (tcp.address() as net.AddressInfo).port;
  try {
    await assert.rejects(assertPortsAvailable(port), /端口.*占用/);
  } finally {
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }
  const udp = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => udp.bind(0, "0.0.0.0", resolve));
  const udpPort = udp.address().port;
  try {
    await assert.rejects(assertPortsAvailable(udpPort), /端口.*占用/);
  } finally {
    udp.close();
  }
});

test("CPU 按真实采样间隔计算，界面重复刷新不改变基准", async () => {
  const f = await fixture();
  try {
    f.runtime.processes = [
      {
        pid: 777,
        ppid: 1,
        name: "bedrock_server.exe",
        path: path.join(f.root, "bedrock_server.exe"),
        command: "",
        memory: 100,
        cpuTime: 10,
        createdAt: Date.now(),
      },
    ];
    (f.runtime as any).sampleAt = 100000;
    await f.runtime.snapshot(f.i, false);
    (f.runtime as any).sampleAt = 102000;
    f.runtime.processes[0].cpuTime = 10.2;
    const first = await f.runtime.snapshot(f.i, false);
    const again = await f.runtime.snapshot(f.i, false);
    assert.equal(first.metric.cpu, again.metric.cpu);
    assert(Math.abs(first.metric.cpu! - 10 / os.cpus().length) < 0.00001);
    (f.runtime as any).sampleAt = 104000;
    const idle = await f.runtime.snapshot(f.i, false);
    assert.equal(idle.metric.cpu, 0);
  } finally {
    await f.cleanup();
  }
});

test("Lolia 刷新保留日本转接端口和 UDP 网卡覆盖", () => {
  const signal = applyTunnelOverrides(
    {
      proxies: [
        {
          type: "https",
          localIP: "192.168.1.144",
          localPort: 19132,
          customDomains: ["rb.example.com"],
        },
      ],
    },
    "C:/private",
    { httpTargetPort: 19232, enableAutoTLS: true },
  );
  assert.equal(signal.proxies[0].plugin.localAddr, "192.168.1.144:19232");
  assert.equal(signal.proxies[0].plugin.autoTLS.enable, true);
  const udp = applyTunnelOverrides(
    { proxies: [{ type: "udp", localIP: "127.0.0.1", localPort: 19132 }] },
    "C:/private",
    { udpLocalIP: "192.168.1.144" },
  );
  assert.equal(udp.proxies[0].localIP, "192.168.1.144");
  assert.throws(
    () => applyTunnelOverrides({ proxies: [{ type: "tcp" }] }, "C:/private"),
    /信令或 UDP/,
  );
});

test("更新启动检查失败后回退核心并移除新版本文件", async () => {
  const f = await fixture();
  try {
    const installer = new Installer(
      f.store,
      f.runtime,
      f.backups,
      f.content,
      path.resolve("resources"),
    );
    const original = await f.runtime.get(f.i.id);
    let running = true,
      starts = 0;
    (f.runtime as any).get = async () => ({
      ...original,
      pid: running ? 123 : null,
    });
    (f.runtime as any).stop = async () => {
      running = false;
      return true;
    };
    (f.runtime as any).start = async () => {
      if (++starts === 1) throw new Error("new core failed readiness");
      running = true;
      return true;
    };
    (installer as any).prepare = async (
      _core: any,
      _version: any,
      _zip: any,
      stage: string,
    ) => {
      await fs.mkdir(stage, { recursive: true });
      await fs.writeFile(
        path.join(stage, "bedrock_server.exe"),
        "new broken core",
      );
      await fs.writeFile(
        path.join(stage, "new-version.dll"),
        "must disappear on rollback",
      );
      return { version: "99.0.0" };
    };
    await assert.rejects(
      installer.update(f.i.id, undefined, undefined, f.ctx),
      /failed readiness/,
    );
    assert.equal(
      await fs.readFile(path.join(f.root, "bedrock_server.exe"), "utf8"),
      "mock, never launched",
    );
    await assert.rejects(fs.stat(path.join(f.root, "new-version.dll")));
    assert.equal(running, true);
    assert.equal(f.store.instance(f.i.id).version, undefined);
    assert(f.store.backups().length >= 2);
  } finally {
    await f.cleanup();
  }
});

test("官方 BDS 切换保留 Endstone 环境，快照恢复及重关联还原核心元数据", async () => {
  const f = await fixture();
  let reopenedRuntime: Runtime | undefined;
  let reopenedStore: Store | undefined;
  try {
    const toolsRoot = path.join(f.temp, "managed-tools");
    const oldPython = path.join(
      toolsRoot,
      "runtimes",
      "endstone",
      "previous",
      "Scripts",
      "python.exe",
    );
    await fs.mkdir(path.dirname(oldPython), { recursive: true });
    await fs.writeFile(oldPython, "old-python");
    await fs.mkdir(
      path.join(
        path.dirname(path.dirname(oldPython)),
        "Lib",
        "site-packages",
        "endstone",
      ),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        path.dirname(path.dirname(oldPython)),
        "Lib",
        "site-packages",
        "endstone",
        "_version.py",
      ),
      '__version__ = version = "0.11.15"',
    );
    f.store.set("managed-tools-root", toolsRoot);
    Object.assign(f.i, {
      core: "bds",
      preferredCore: "endstone",
      python: oldPython,
      version: "1.26.61.1",
    });
    await f.runtime.saveInstance(f.i);

    let running = true;
    const base = await f.runtime.get(f.i.id);
    (f.runtime as any).get = async () => {
      const current = f.store.instance(f.i.id);
      return {
        ...base,
        version: current.version || "1.26.61.1",
        endstoneVersion: current.core === "endstone" ? "0.11.15" : "",
        status: running ? "running" : "stopped",
        pid: running ? 9923 : null,
        metric: { ...base.metric, players: 0 },
      };
    };
    (f.runtime as any).stop = async () => {
      running = false;
      return true;
    };
    (f.runtime as any).start = async () => {
      running = true;
      return true;
    };

    const installer = new Installer(
      f.store,
      f.runtime,
      f.backups,
      f.content,
      path.resolve("resources"),
    );
    const newPython = path.join(
      toolsRoot,
      "runtimes",
      "endstone",
      "new-env",
      "Scripts",
      "python.exe",
    );
    await fs.mkdir(path.dirname(newPython), { recursive: true });
    await fs.writeFile(newPython, "new-python");
    await fs.mkdir(
      path.join(
        path.dirname(path.dirname(newPython)),
        "Lib",
        "site-packages",
        "endstone",
      ),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        path.dirname(path.dirname(newPython)),
        "Lib",
        "site-packages",
        "endstone",
        "_version.py",
      ),
      '__version__ = version = "0.11.16"',
    );
    (installer as any).prepare = async (
      core: string,
      version: string,
      _zip: string,
      stage: string,
    ) => {
      await fs.mkdir(stage, { recursive: true });
      await fs.writeFile(
        path.join(stage, "bedrock_server.exe"),
        core === "endstone" ? "endstone-core" : "bds-core",
      );
      await fs.writeFile(path.join(stage, "version.txt"), "1.26.61.1");
      return core === "endstone"
        ? {
            version: version === "0.11.15" ? "1.26.60.6" : "1.26.61.1",
            endstoneVersion: version,
            python: newPython,
          }
        : { version: "1.26.61.1" };
    };

    await assert.rejects(
      installer.update(f.i.id, "0.11.15", undefined, f.ctx, "endstone"),
      /拒绝降级/,
    );
    assert.equal(f.store.instance(f.i.id).core, "bds");
    assert.equal(running, true);

    const result = await installer.update(
      f.i.id,
      "0.11.16",
      undefined,
      f.ctx,
      "endstone",
    );
    assert.equal(result.core, "endstone");
    assert.equal(f.store.instance(f.i.id).core, "endstone");
    assert.equal(f.store.instance(f.i.id).python, newPython);
    assert.equal(f.store.instance(f.i.id).preferredCore, "endstone");

    await f.backups.restore(result.rollbackBackup!, f.ctx);
    const restored = f.store.instance(f.i.id);
    assert.equal(restored.core, "bds");
    assert.equal(restored.preferredCore, "endstone");
    assert.equal(restored.python, oldPython);
    assert.equal(restored.version, "1.26.61.1");

    reopenedStore = new Store(path.join(f.temp, "reopened-data"));
    reopenedStore.set("managed-tools-root", toolsRoot);
    reopenedRuntime = new Runtime(
      reopenedStore,
      () => {},
      path.resolve("resources"),
    );
    const reopened = await reopenedRuntime.import(f.root);
    assert.equal(reopened.core, "bds");
    assert.equal(reopened.preferredCore, "endstone");
    assert.equal(reopened.python, oldPython);
  } finally {
    reopenedRuntime?.dispose();
    reopenedStore?.close();
    await f.cleanup();
  }
});
