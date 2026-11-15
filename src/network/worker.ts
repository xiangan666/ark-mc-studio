/** One bounded network operation, independent of the live game-server owner. */
import fs from "node:fs/promises";
import path from "node:path";
import { Store } from "../agent/store";
import { Runtime, runFile } from "../agent/runtime";
import { Network } from "../agent/network";
import { errorText } from "../agent/safe";
import { networkControlSchema } from "../shared/network-control";
import type { AgentEvent, Job } from "../shared/types";
import { networkProcesses } from "../agent/processes";
import { Tools } from "../agent/tools";

const abort = new AbortController();
process.on("message", (message: any) => {
  if (message?.cancel) abort.abort();
});
function send(value: unknown) {
  if (process.connected) process.send?.(value, () => {});
}

process.once("message", async (message: any) => {
  let store: Store | undefined;
  let lock: fs.FileHandle | undefined;
  let lockFile = "";
  try {
    const request = networkControlSchema.parse(message.request);
    store = new Store(message.dataRoot);
    const instanceId = "id" in request.args ? request.args.id : null;
    if (instanceId) store.instance(instanceId);
    const readonly = ["tools.list", "tunnels.get"].includes(request.method);
    lockFile = path.join(
      store.root,
      `network-${readonly ? process.pid : instanceId || "tools"}.lock`,
    );
    try {
      lock = await fs.open(lockFile, "wx");
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const previous = JSON.parse(await fs.readFile(lockFile, "utf8"));
      try {
        process.kill(previous.pid, 0);
        throw new Error("该实例已有网络操作正在执行");
      } catch (reason: any) {
        if (reason.code !== "ESRCH") throw reason;
      }
      await fs.unlink(lockFile);
      lock = await fs.open(lockFile, "wx");
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    const events = (event: AgentEvent) => send({ event });
    const runtime = new Runtime(store, events, message.resources);
    // A fresh, one-shot sample: no game ownership, log ingestion, or background timers.
    runtime.processes = await networkProcesses();
    const network = new Network(
      store,
      runtime,
      message.resources,
      message.toolsRoot,
    );
    const tools = new Tools(
      store,
      runtime,
      message.resources,
      message.toolsRoot,
    );
    if (request.method === "tunnels.get") {
      send({ result: await network.get(request.args.id) });
    } else if (request.method === "routers.save") {
      const result = await network.saveRouter(
        request.args.id,
        request.args.config,
      );
      send({ result });
    } else if (request.method === "tools.list") {
      send({ result: await tools.list(request.args.check) });
    } else if (request.method === "tunnels.target") {
      send({
        result: await network.updateTarget(
          request.args.id,
          request.args.tunnelId,
          request.args.ip,
        ),
      });
    } else if (request.method === "tunnels.prepare") {
      send({ result: await tools.prepareNetwork(request.args.id) });
    } else {
      const job: Job = { ...message.job, status: "running" };
      const save = () => {
        store!.put("jobs", job!);
        events({ type: "job", data: { ...job! } });
      };
      save();
      send({ result: job });
      try {
        const context = {
          id: job.id,
          signal: abort.signal,
          update: (progress: number, detail: string) => {
            job.progress = progress;
            job.detail = detail;
            save();
          },
        };
        switch (request.method) {
          case "tunnels.action":
            job.result = await network.action(
              request.args.id,
              request.args.action,
              request.args.tunnelId,
              context,
            );
            break;
          case "tunnels.import":
            await tools.prepareNetwork(request.args.id);
            job.result = await network.import(
              request.args.id,
              request.args.tunnelId,
              request.args.token,
              context,
              request.args.provider,
            );
            break;
          case "tunnels.attach":
            job.result = await tools.organize(
              request.args.id,
              request.args.root,
              context,
            );
            break;
          case "tools.organize":
            job.result = await tools.organize(
              request.args.id,
              request.args.source,
              context,
            );
            break;
          case "tools.install":
            job.result = await tools.install(request.args.tool, context);
            break;
          case "tools.router-runtime":
            job.result = await tools.prepareRouterRuntime(context);
            break;
        }
        job.status = "success";
        job.progress = 100;
        job.detail = "已完成";
      } catch (error) {
        job.status = abort.signal.aborted ? "cancelled" : "failed";
        job.detail = errorText(error);
      } finally {
        job.finishedAt = Date.now();
        save();
      }
    }
  } catch (error) {
    send({ error: errorText(error) });
  } finally {
    store?.db.close();
    if (lock) {
      await lock.close();
      await fs.unlink(lockFile).catch(() => {});
    }
    send({ done: true });
    process.disconnect?.();
  }
});
