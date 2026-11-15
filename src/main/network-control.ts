import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { networkControlSchema } from "../shared/network-control";
import type { AgentEvent, Bootstrap, Job } from "../shared/types";
import type { AgentClient } from "./agent-client";

export class NetworkControl {
  private active = new Map<string, ChildProcess | null>();
  private jobs = new Map<string, ChildProcess>();
  get isBusy() {
    return this.active.size > 0;
  }
  constructor(
    private agent: AgentClient,
    private dataRoot: string,
    private toolsRoot: string,
    private node: string,
    private worker: string,
    private resources: string,
    private emit: (event: AgentEvent) => void,
  ) {}

  busy(id: string) {
    return this.active.has(id) || this.active.has("tools");
  }
  cancel(id: string) {
    const child = this.jobs.get(id);
    if (!child) return false;
    if (child.connected) child.send({ cancel: true });
    return true;
  }
  async call(method: string, args: unknown) {
    const request = networkControlSchema.parse({ method, args });
    const instanceId = "id" in request.args ? request.args.id : null;
    const readonly = ["tools.list", "tunnels.get"].includes(request.method);
    const id = readonly ? `read-${randomUUID()}` : instanceId || "tools";
    if (!readonly && (this.busy(id) || (!instanceId && this.active.size)))
      throw new Error("该实例网络或工具操作正在执行，请等待完成");
    this.active.set(id, null);
    try {
      const state = await this.agent.call<Bootstrap>("bootstrap");
      if (instanceId && !state.instances.some((i) => i.id === instanceId))
        throw new Error("实例不存在");
      if (
        !readonly &&
        state.jobs.some(
          (j) =>
            ["running", "queued"].includes(j.status) &&
            (j.instanceId === instanceId || j.type === "tools"),
        )
      )
        throw new Error("请等待实例任务或工具安装完成后操作网络");
      const isTool =
        request.method.startsWith("tools.") ||
        ["tunnels.attach", "tunnels.prepare"].includes(request.method);
      const job: Job = {
        id: randomUUID(),
        instanceId,
        type: isTool ? "tools" : "tunnel",
        title: isTool ? "统一工具管理" : "统一网络控制",
        status: "queued",
        progress: 0,
        detail: "等待网络控制器",
        createdAt: Date.now(),
      };
      const child = fork(this.worker, [], {
        execPath: this.node,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      this.active.set(id, child);
      this.jobs.set(job.id, child);
      child.unref();
      return await new Promise<unknown>((resolve, reject) => {
        let replied = false;
        const timer = setTimeout(() => {
          if (!replied) {
            replied = true;
            reject(new Error("网络控制器响应超时，请检查任务记录后重试"));
          }
          if (child.connected) child.send({ cancel: true });
        }, 180000);
        child.on("message", (message: any) => {
          if (message.event) this.emit(message.event);
          if (Object.hasOwn(message, "result") && !replied) {
            replied = true;
            resolve(message.result);
          }
          if (message.error && !replied) {
            replied = true;
            reject(new Error(message.error));
          }
        });
        child.once("error", (error) => {
          if (!replied) {
            replied = true;
            reject(error);
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          this.active.delete(id);
          this.jobs.delete(job.id);
          if (!replied) reject(new Error("网络控制器提前退出，请检查线路配置"));
        });
        child.send({
          request,
          job,
          dataRoot: this.dataRoot,
          toolsRoot: this.toolsRoot,
          resources: this.resources,
        });
      });
    } catch (error) {
      if (this.active.get(id) === null) this.active.delete(id);
      throw error;
    }
  }
}
