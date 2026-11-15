import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { API, schemas } from "../src/agent/api";
import {
  compareVersions,
  windowsEndstoneVersions,
} from "../src/agent/releases";
import {
  autoUpdateBlock,
  defaultCoreUpdatePolicy,
  nextMaintenance,
} from "../src/agent/core-updates";
import {
  measureRouteQuality,
  signalSample,
  recommendRoute,
  summarizeQuality,
} from "../src/agent/route-quality";
import { Store } from "../src/agent/store";
import { sleep } from "../src/agent/safe";
import type { CoreUpdateReport, Route, Snapshot } from "../src/shared/types";

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-updates-"));
  const server = path.join(temp, "测试核心");
  await fs.mkdir(server);
  await fs.writeFile(path.join(server, "bedrock_server.exe"), "old-core");
  await fs.writeFile(
    path.join(server, "server.properties"),
    "server-name=测试\nlevel-name=地图\nmax-players=50\nserver-port=29439\n",
  );
  const api = new API(
    new Store(path.join(temp, "data")),
    () => {},
    path.resolve("resources"),
    path.join(temp, "tools"),
  );
  const instance = await api.runtime.import(server);
  const snapshot = await api.runtime.get(instance.id);
  let running = true,
    players = 0;
  const current = (): Snapshot => ({
    ...snapshot,
    version: "1.26.60.6",
    endstoneVersion: instance.core === "endstone" ? "0.11.15" : "",
    status: running ? "running" : "stopped",
    pid: running ? 9923 : null,
    capabilities: { managed: true, command: true, tps: false },
    metric: { ...snapshot.metric, players },
  });
  api.runtime.get = async () => current();
  Object.defineProperty(api.runtime, "telemetryFresh", { get: () => true });
  api.runtime.stop = async () => {
    running = false;
    return true;
  };
  api.runtime.start = async () => {
    running = true;
    return true;
  };
  const report: CoreUpdateReport = {
    checkedAt: Date.now(),
    core: "bds",
    currentBds: "1.26.60.6",
    currentEndstone: "",
    latestBds: "1.26.61.1",
    compatibleBds: "1.26.61.1",
    status: "available",
    updateAvailable: true,
    detail: "有可用更新",
    releaseUrl: "https://www.minecraft.net/download/server/bedrock",
  };
  async function settle() {
    for (let n = 0; n < 300; n++) {
      if (
        !api.store.jobs().some((j) => ["running", "queued"].includes(j.status))
      )
        return;
      await sleep(10);
    }
    throw new Error("任务未完成");
  }
  function due() {
    const now = Date.now();
    api.store.set(`core-updates:${instance.id}`, {
      policy: {
        autoCheck: true,
        autoUpdate: true,
        intervalHours: 6,
        maintenanceTime: "04:00",
      },
      nextCheckAt: now + 9999999,
      nextUpdateAt: now - 1,
      maintenanceWindowAt: now - 1000,
      report,
    });
  }
  return {
    api,
    temp,
    server,
    instance,
    current,
    report,
    settle,
    due,
    players(value: number) {
      players = value;
    },
    async cleanup() {
      api.dispose();
      await fs.rm(temp, { recursive: true, force: true });
    },
  };
}

test("官方版本比较与发行筛选排除预发布、撤回包和不兼容的 Python 平台", () => {
  assert.equal(compareVersions("0.11.15", "0.9.9"), 1);
  assert.equal(compareVersions("1.26.60", "1.26.60.0"), 0);
  assert.equal(compareVersions("已安装", "0.11.15"), null);
  const wheel = (version: string, extra = {}) => ({
    filename: `endstone-${version}-cp313-cp313-win_amd64.whl`,
    ...extra,
  });
  assert.deepEqual(
    windowsEndstoneVersions({
      releases: {
        "0.11.15": [wheel("0.11.15")],
        "0.12.0": [wheel("0.12.0", { yanked: true })],
        "0.13.0": [{ filename: "endstone-0.13.0-cp314-cp314-win_amd64.whl" }],
        "0.14.0rc1": [wheel("0.14.0rc1")],
      },
    }),
    ["0.11.15"],
  );
  assert.throws(() =>
    schemas["core-updates.save"].parse({
      id: randomUUID(),
      policy: {
        autoCheck: true,
        autoUpdate: true,
        intervalHours: 0,
        maintenanceTime: "25:00",
      },
    }),
  );
});

test("Endstone 按官方兼容组合检查，独立 BDS 有新版不误报为可直接更新", async (t) => {
  const f = await fixture();
  try {
    f.instance.core = "endstone";
    f.api.store.put("instances", f.instance);
    t.mock.method(f.api.installer, "catalog", async () => ({
      bds: { version: "1.26.61.1", url: "" },
      endstone: { version: "0.11.15", versions: ["0.11.15"] },
      errors: [],
      eula: "",
    }));
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (input: any) => {
      requests++;
      const content = String(input).includes("__init__.pyi")
        ? '__minecraft_version__ = "26.60"'
        : JSON.stringify({
            version: "1.26.60",
            binary: {
              windows: {
                url: "https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.60.6.zip",
                sha256: "a".repeat(64),
              },
            },
          });
      return new Response(
        JSON.stringify({
          encoding: "base64",
          size: content.length,
          content: Buffer.from(content).toString("base64"),
        }),
      );
    });
    const report = await f.api.coreUpdates.check(f.instance.id);
    assert.equal(report.status, "current");
    assert.equal(report.updateAvailable, false);
    assert.equal(report.compatibleBds, "1.26.60.6");
    assert.match(report.detail, /默认等待 Endstone 官方适配/);
    assert.equal(requests, 2);
    await f.api.coreUpdates.check(f.instance.id);
    assert.equal(requests, 2);
    assert.equal(
      await fs.readFile(path.join(f.server, "bedrock_server.exe"), "utf8"),
      "old-core",
    );
  } finally {
    await f.cleanup();
  }
});

test("Endstone 默认等待官方适配，也可明确选择官方 BDS", async (t) => {
  const f = await fixture();
  try {
    f.instance.core = "endstone";
    f.api.store.put("instances", f.instance);
    assert.equal(defaultCoreUpdatePolicy.incompatibleEndstone, "wait");
    assert.equal(
      f.api.coreUpdates.get(f.instance.id).policy.incompatibleEndstone,
      "wait",
    );
    t.mock.method(f.api.installer, "catalog", async () => ({
      bds: { version: "1.26.61.1", url: "" },
      endstone: { version: "0.11.15", versions: ["0.11.15"] },
      errors: [],
      eula: "",
    }));
    f.api.store.set("endstone-compatibility:0.11.15", {
      at: Date.now(),
      version: "1.26.60.6",
    });
    const waiting = await f.api.coreUpdates.check(f.instance.id);
    assert.equal(waiting.targetCore, "endstone");
    assert.equal(waiting.updateAvailable, false);
    assert.match(waiting.detail, /默认等待 Endstone 官方适配/);

    f.api.coreUpdates.save(f.instance.id, {
      ...defaultCoreUpdatePolicy,
      incompatibleEndstone: "official-bds",
    });
    const selected = await f.api.coreUpdates.check(f.instance.id);
    assert.equal(selected.targetCore, "bds");
    assert.equal(selected.updateAvailable, true);
    assert.match(selected.detail, /Endstone 插件.*暂停加载/);
  } finally {
    await f.cleanup();
  }
});

test("官方检查失败明确显示未确认，不能沿用旧结果自动安装", async (t) => {
  const f = await fixture();
  try {
    f.due();
    t.mock.method(f.api.installer, "catalog", async () => {
      throw Error("official unavailable");
    });
    const report = await f.api.coreUpdates.check(f.instance.id);
    assert.equal(report.status, "unavailable");
    assert.equal(report.updateAvailable, false);
    assert.match(report.error!, /official unavailable/);
    assert.equal(
      f.api.coreUpdates.get(f.instance.id).report?.updateAvailable,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("自动更新默认关闭，有玩家或采样不明时延后，错过窗口不补做", async (t) => {
  const f = await fixture();
  try {
    await f.api.coreUpdates.tick();
    assert.equal(f.api.store.jobs().length, 0);
    assert.equal(f.api.coreUpdates.get(f.instance.id).policy.autoUpdate, false);
    assert.match(autoUpdateBlock(f.current(), false)!, /采样/);
    f.players(1);
    f.due();
    await f.api.coreUpdates.tick();
    await f.settle();
    assert.match(
      f.api.coreUpdates.get(f.instance.id).lastOutcome!.detail,
      /玩家在线/,
    );
    assert(f.api.coreUpdates.get(f.instance.id).nextUpdateAt! > Date.now());
    assert.equal(f.api.store.backups().length, 0);
    const before = f.api.store.jobs().length;
    const state = f.api.coreUpdates.get(f.instance.id);
    f.api.store.set(`core-updates:${f.instance.id}`, {
      ...state,
      nextUpdateAt: Date.now() - 7200000,
      maintenanceWindowAt: Date.now() - 7200000,
    });
    await f.api.coreUpdates.tick();
    assert.equal(f.api.store.jobs().length, before);
    assert.match(
      f.api.coreUpdates.get(f.instance.id).lastOutcome!.detail,
      /错过/,
    );
    const day = new Date(2026, 10, 4, 23, 59).getTime();
    assert.equal(new Date(nextMaintenance("00:10", day)).getDate(), 5);
  } finally {
    await f.cleanup();
  }
});

test("自动更新下载过程中有玩家进入，在停服前再次检查并保留核心", async (t) => {
  const f = await fixture();
  try {
    f.due();
    t.mock.method(f.api.coreUpdates, "check", async () => f.report);
    t.mock.method(f.api.installer as any, "prepare", async () => {
      f.players(2);
      return { version: "1.26.61.1" };
    });
    const stop = t.mock.method(f.api.runtime, "stop", async () => true);
    await f.api.coreUpdates.tick();
    await f.settle();
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(f.api.store.backups().length, 0);
    assert.match(
      f.api.coreUpdates.get(f.instance.id).lastOutcome!.detail,
      /延后/,
    );
    assert.equal(
      await fs.readFile(path.join(f.server, "bedrock_server.exe"), "utf8"),
      "old-core",
    );
  } finally {
    await f.cleanup();
  }
});

test("自动更新使用完整快照并切换核心，下载失败暂停后续自动安装", async (t) => {
  const f = await fixture();
  try {
    t.mock.method(f.api.coreUpdates, "check", async () => f.report);
    const prepare = t.mock.method(
      f.api.installer as any,
      "prepare",
      async (_core: any, _version: any, _zip: any, stage: string) => {
        await fs.mkdir(stage, { recursive: true });
        await fs.writeFile(path.join(stage, "bedrock_server.exe"), "new-core");
        return { version: "1.26.61.1" };
      },
    );
    f.due();
    await f.api.coreUpdates.tick();
    await f.settle();
    assert.equal(
      await fs.readFile(path.join(f.server, "bedrock_server.exe"), "utf8"),
      "new-core",
    );
    assert(f.api.store.backups().some((b) => b.kind === "full" && b.verified));
    assert.match(
      f.api.coreUpdates.get(f.instance.id).lastOutcome!.detail,
      /自动更新完成/,
    );
    prepare.mock.restore();
    t.mock.method(f.api.installer as any, "prepare", async () => {
      throw Error("download interrupted");
    });
    f.due();
    await f.api.coreUpdates.tick();
    await f.settle();
    assert.equal(f.api.coreUpdates.get(f.instance.id).policy.autoUpdate, false);
    assert.match(
      f.api.coreUpdates.get(f.instance.id).lastOutcome!.detail,
      /暂停自动安装/,
    );
    assert.equal(
      await fs.readFile(path.join(f.server, "bedrock_server.exe"), "utf8"),
      "new-core",
    );
  } finally {
    await f.cleanup();
  }
});

test("自动切换到官方 BDS 仅在明确选择该策略时传入 BDS 核心", async (t) => {
  const f = await fixture();
  try {
    f.instance.core = "endstone";
    f.api.store.put("instances", f.instance);
    f.due();
    const state = f.api.coreUpdates.get(f.instance.id);
    f.api.store.set(`core-updates:${f.instance.id}`, {
      ...state,
      policy: { ...state.policy, incompatibleEndstone: "official-bds" },
    });
    t.mock.method(f.api.coreUpdates, "check", async () => ({
      ...f.report,
      core: "endstone",
      targetCore: "bds",
      latestBds: "1.26.61.1",
      compatibleBds: "1.26.60.6",
    }));
    const update = t.mock.method(
      f.api.installer as any,
      "update",
      async () => ({
        version: "1.26.61.1",
        core: "bds",
        rollbackBackup: "snapshot-id",
      }),
    );
    await f.api.coreUpdates.tick();
    await f.settle();
    assert.equal(update.mock.calls[0].arguments[4], "bds");
  } finally {
    await f.cleanup();
  }
});

test("线路质量统计不把失败请求当低延迟，没有可用 UDP 握手时不给优选", () => {
  const samples = [
    { ok: true, elapsedMs: 100 },
    { ok: false, elapsedMs: 6000 },
    { ok: true, elapsedMs: 200 },
    { ok: true, elapsedMs: 250 },
    { ok: true, elapsedMs: 150 },
  ];
  const summary = summarizeQuality(samples);
  assert.equal(summary.medianMs, 175);
  assert.equal(summary.failureRate, 20);
  assert.equal(summary.p95Ms, 250);
  assert.equal(summary.jitterMs, 75);
  assert.equal(summarizeQuality([{ ok: false, elapsedMs: 50 }]).medianMs, null);
  const base = {
    signalId: 1,
    name: "test",
    host: "example.com",
    port: 443,
    checkedAt: Date.now(),
    samples,
    ...summary,
  };
  assert.equal(
    recommendRoute([
      { ...base, transport: { status: "fail", detail: "UDP blocked" } },
    ]),
    undefined,
  );
  assert.equal(
    recommendRoute([
      { ...base, transport: { status: "pass", detail: "ok" } },
      {
        ...base,
        signalId: 2,
        failureRate: 0,
        transport: { status: "pass", detail: "ok" },
      },
    ]),
    2,
  );
});

test("线路质量实际访问本地信令接口，分开记录 HTTP 成功和 UDP 握手失败，取消生效", async () => {
  let status = 200,
    requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(status);
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const controller = new AbortController();
  const route = {
    name: "测试线路",
    signalId: 1,
    host: "127.0.0.1",
    port: (server.address() as any).port,
    protocol: "http",
  } as Route;
  const ctx = { id: randomUUID(), signal: controller.signal, update: () => {} };
  try {
    const result = await measureRouteQuality(
      route,
      ctx,
      async () => {
        throw Error("UDP blocked");
      },
      () => {},
    );
    assert.equal(requests, 5);
    assert.equal(result.failureRate, 0);
    assert.equal(result.transport.status, "fail");
    status = 503;
    const failed = await signalSample(route, controller.signal);
    assert.equal(failed.ok, false);
    assert.match(failed.error!, /503/);
    controller.abort();
    await assert.rejects(
      measureRouteQuality(
        route,
        ctx,
        async () => ({ detail: "" }),
        () => {},
      ),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
