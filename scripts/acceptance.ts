import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { API } from "../src/agent/api";
import { Store } from "../src/agent/store";
import { sleep } from "../src/agent/safe";
import type { Job, Instance } from "../src/shared/types";

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-acceptance-"));
  const store = new Store(path.join(temp, "data"));
  const api = new API(store, () => {}, path.resolve("resources"));
  let instance: Instance | undefined;
  const results: any = {
    startedAt: new Date().toISOString(),
    temporaryRoot: temp,
    productionModified: false,
  };
  let success = false;
  try {
    await api.init(false);
    for (let n = 0; n < 20 && !api.runtime.samplerReady; n++) await sleep(500);
    async function complete(job: Job) {
      const deadline = Date.now() + 600000;
      let prior = "";
      while (Date.now() < deadline) {
        const state = store.jobs().find((j) => j.id === job.id)!;
        if (state.detail !== prior) {
          console.log(
            state.title,
            Math.round(state.progress) + "%",
            state.detail,
          );
          prior = state.detail;
        }
        if (state.status === "success") return state.result;
        if (["failed", "cancelled", "interrupted"].includes(state.status))
          throw new Error(state.detail);
        await sleep(1000);
      }
      throw new Error("验收任务超时");
    }
    const catalog = await api.installer.catalog();
    results.catalog = {
      bds: catalog.bds?.version,
      endstone: catalog.endstone?.version,
    };
    console.log("Official catalog", JSON.stringify(results.catalog));
    const created = (await api.call("install.create", {
      name: "方舟验收临时世界",
      root: path.join(temp, "isolated-endstone"),
      core: "endstone",
      version: "0.11.15",
      port: 29482,
      accepted: true,
    })) as Job;
    instance = (await complete(created)) as Instance;
    results.install = true;
    await complete(
      (await api.call("server.action", {
        id: instance.id,
        action: "start",
      })) as Job,
    );
    results.start = true;
    await api.runtime.command(instance.id, "status");
    await sleep(2500);
    await api.runtime.refresh();
    const first = await api.runtime.get(instance.id);
    results.initialStatus = {
      status: first.status,
      version: first.version,
      tps: first.metric.tps,
      pid: first.pid,
      world: first.world,
    };
    if (!first.pid || first.port !== 29482)
      throw new Error("临时实例状态不匹配");
    await complete(
      (await api.call("server.action", {
        id: instance.id,
        action: "restart",
        countdown: 0,
      })) as Job,
    );
    results.restart = true;
    const backup = (await complete(
      (await api.call("backups.create", {
        id: instance.id,
        kind: "world",
      })) as Job,
    )) as any;
    results.onlineBackup = {
      files: backup.files,
      verified: backup.verified,
      size: backup.size,
    };
    await complete(
      (await api.call("backups.verify", { backupId: backup.id })) as Job,
    );
    results.verify = true;
    await complete(
      (await api.call("server.action", {
        id: instance.id,
        action: "stop",
      })) as Job,
    );
    results.gracefulStop = true;
    await complete(
      (await api.call("backups.restore", { backupId: backup.id })) as Job,
    );
    results.restore = true;
    success = true;
    results.passed = true;
    console.log(
      "官方 Endstone 安装、运行、重启、在线备份、校验、正常停止与恢复均通过。",
    );
  } catch (error) {
    results.passed = false;
    results.error = error instanceof Error ? error.message : String(error);
    if (instance) results.lastLogs = api.runtime.logs(instance.id).slice(-50);
    throw error;
  } finally {
    if (instance) {
      try {
        await api.runtime.stop(instance.id);
      } catch {}
    }
    api.dispose();
    await fs.mkdir("test-results", { recursive: true });
    await fs.writeFile(
      "test-results/acceptance.json",
      JSON.stringify(results, null, 2),
    );
    if (success) await fs.rm(temp, { recursive: true, force: true });
    else console.log("保留失败现场", temp);
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
