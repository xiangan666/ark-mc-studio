import { randomUUID } from "node:crypto";
import type { AgentEvent, Job } from "../shared/types";
import { Store } from "./store";
import { errorText } from "./safe";

export interface JobContext {
  id: string;
  signal: AbortSignal;
  update(progress: number, detail: string): void;
}
export class Jobs {
  private queues = new Map<string, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  constructor(
    private store: Store,
    private emit: (event: AgentEvent) => void,
  ) {
    for (const job of store
      .jobs()
      .filter((j) => ["running", "queued"].includes(j.status))) {
      job.status = "interrupted";
      job.detail = "后台意外退出，任务已标记中断；请检查结果后重试";
      job.finishedAt = Date.now();
      store.put("jobs", job);
    }
  }
  run(
    instanceId: string | null,
    type: string,
    title: string,
    action: (ctx: JobContext) => Promise<unknown>,
  ): Job {
    const job: Job = {
      id: randomUUID(),
      instanceId,
      type,
      title,
      status: "queued",
      progress: 0,
      detail: "等待执行",
      createdAt: Date.now(),
    };
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const save = () => {
      this.store.put("jobs", job);
      this.emit({ type: "job", data: { ...job } });
    };
    save();
    const key = instanceId || "global";
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        try {
          controller.signal.throwIfAborted();
          job.status = "running";
          save();
          const result = await action({
            id: job.id,
            signal: controller.signal,
            update: (progress, detail) => {
              job.progress = Math.max(0, Math.min(100, progress));
              job.detail = detail;
              save();
            },
          });
          job.result = result;
          job.status = "success";
          job.progress = 100;
          job.detail = "已完成";
        } catch (error) {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.detail = errorText(error);
        } finally {
          job.finishedAt = Date.now();
          this.controllers.delete(job.id);
          save();
          const entry = this.store.activity(
            instanceId,
            `${title}：${job.status === "success" ? "完成" : job.detail}`,
            job.status === "failed" ? "error" : "info",
          );
          this.emit({ type: "activity", data: entry });
        }
      });
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return job;
  }
  cancel(id: string) {
    const controller = this.controllers.get(id);
    if (!controller) throw new Error("该任务已经结束");
    controller.abort();
    return true;
  }
  busy(id: string) {
    return this.store
      .jobs()
      .some((j) => j.instanceId === id && j.status === "running");
  }
}
