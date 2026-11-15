import path from "node:path";
import { atomicWrite, json } from "../agent/safe";
import type { AgentClient } from "./agent-client";
import type { DirectRoutes } from "./direct-routes";
import type { NetworkControl } from "./network-control";
import type { Bootstrap, Job, Tunnel } from "../shared/types";
import type {
  ProgramPlan,
  ProgramTransition,
} from "../shared/program-lifecycle";

export class ProgramLifecycle {
  private operation?: Promise<void>;
  private state: ProgramTransition;
  private file: string;
  constructor(
    private agent: AgentClient,
    private direct: DirectRoutes,
    private network: NetworkControl,
    private root: string,
    private version: string,
    private afterUpgrade: () => Promise<unknown>,
  ) {
    this.file = path.join(root, "program-transition.json");
    this.state = {
      version,
      mode: "upgrade",
      phase: "idle",
      progress: 0,
      detail: "等待确认",
      plans: [],
    };
  }
  async init() {
    const previous = await json<ProgramTransition | null>(this.file, null);
    if (
      previous?.mode === "upgrade" &&
      previous.phase !== "complete" &&
      previous.plans.length
    ) {
      this.state = {
        ...previous,
        version: this.version,
        phase: "failed",
        detail: "上次更新尚未完成，可重新确认后恢复",
        error: previous.error || "更新流程被中断",
      };
    }
  }
  get busy() {
    return !!this.operation;
  }
  get status() {
    return { ...this.state };
  }
  acceptsService(version: string) {
    return version === this.version;
  }
  private async save(detail: string, progress: number) {
    this.state = { ...this.state, detail, progress };
    await atomicWrite(this.file, JSON.stringify(this.state, null, 2));
  }
  private async job(job: Job) {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const current = (await this.agent.call<Bootstrap>("bootstrap")).jobs.find(
        (j) => j.id === job.id,
      );
      if (current?.status === "success") return;
      if (
        current &&
        ["failed", "cancelled", "interrupted"].includes(current.status)
      )
        throw new Error(current.detail);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("操作仍未完成，请检查任务记录；未强行结束服务器");
  }
  private async prepare(mode: "upgrade" | "quit"): Promise<ProgramPlan[]> {
    if (this.network.isBusy || this.direct.isBusy)
      throw new Error("请等待当前网络操作完成后再更新或退出");
    let state = await this.agent.call<Bootstrap>("bootstrap");
    for (let n = 0; !state.samplerReady && n < 20; n++) {
      await new Promise((r) => setTimeout(r, 500));
      state = await this.agent.call<Bootstrap>("bootstrap");
    }
    if (!state.samplerReady && state.instances.length)
      throw new Error("进程采样尚未就绪，请稍后重试");
    if (state.jobs.some((j) => ["running", "queued"].includes(j.status)))
      throw new Error("请等待当前任务完成后再更新或退出");
    const plans: ProgramPlan[] = [];
    for (const instance of state.instances) {
      const snap = state.snapshots.find((s) => s.id === instance.id);
      if (!snap || ["starting", "stopping", "unknown"].includes(snap.status))
        throw new Error(`${instance.name} 的运行状态尚未确认`);
      if (mode === "quit" && snap.pid && !snap.capabilities.command)
        throw new Error(
          `${instance.name} 无法安全控制，请先通过原启动窗口正常关服`,
        );
      const network = await this.agent.call<{
        tunnels: Tunnel[];
        routers?: { signalId: number; running: boolean }[];
      }>("tunnels.get", { id: instance.id });
      const direct = await this.direct.get(instance.id);
      plans.push({
        id: instance.id,
        name: instance.name,
        root: instance.root,
        server: !!snap.pid,
        tunnels: [
          ...new Set([
            ...network.tunnels
              .filter((t) => t.running)
              .sort(
                (a, b) => Number(b.type === "udp") - Number(a.type === "udp"),
              )
              .map((t) => t.id),
            ...(network.routers || [])
              .filter((r) => r.running)
              .map((r) => r.signalId),
          ]),
        ],
        direct: !!direct.running,
      });
    }
    return plans;
  }
  private async stop(plans: ProgramPlan[]) {
    for (const plan of plans) {
      await this.save(`正常保存并关闭 ${plan.name}`, 15);
      const state = await this.agent.call<Bootstrap>("bootstrap");
      if (state.snapshots.find((s) => s.id === plan.id)?.pid)
        await this.job(
          await this.agent.call<Job>("server.action", {
            id: plan.id,
            action: "stop",
          }),
        );
      if ((await this.direct.get(plan.id)).running)
        await this.direct.action(plan.id, "stop");
      if (plan.tunnels.length) {
        await this.save(`停止 ${plan.name} 的穿透与信令转接`, 35);
        await this.job(
          (await this.network.call("tunnels.action", {
            id: plan.id,
            action: "stop",
          })) as Job,
        );
        const deadline = Date.now() + 15000;
        while (true) {
          const stopped = await this.agent.call<{
            tunnels: Tunnel[];
            routers?: { running: boolean }[];
          }>("tunnels.get", { id: plan.id });
          if (
            !stopped.tunnels.some((t) => t.running) &&
            !stopped.routers?.some((r) => r.running)
          )
            break;
          if (Date.now() >= deadline)
            throw new Error(`${plan.name} 的线路仍在退出，请稍后重试`);
          await new Promise((r) => setTimeout(r, 500));
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  startUpgrade() {
    if (this.operation) return this.status;
    const resume =
      this.state.phase === "failed" && this.state.mode === "upgrade"
        ? this.state.plans
        : [];
    this.state = {
      ...this.state,
      mode: "upgrade",
      phase: "running",
      error: undefined,
      detail: "检查运行状态与当前任务",
      progress: 1,
    };
    this.operation = this.perform("upgrade", resume).finally(() => {
      this.operation = undefined;
    });
    void this.operation.catch(() => {});
    return this.status;
  }
  async quit() {
    if (this.operation) throw new Error("正在更新或退出，请等待完成");
    this.operation = this.perform("quit").finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  private async perform(mode: "upgrade" | "quit", resume: ProgramPlan[] = []) {
    let plans: ProgramPlan[] = [];
    this.state = {
      version: this.version,
      mode,
      phase: "running",
      progress: 1,
      detail: "检查运行状态与当前任务",
      plans: resume,
      startedAt: Date.now(),
    };
    try {
      const current = await this.prepare(mode);
      for (const previous of resume) {
        if (
          !current.some((p) => p.id === previous.id && p.root === previous.root)
        )
          throw new Error(`${previous.name} 的实例路径已变化，停止自动恢复`);
      }
      plans = current.map((plan) => {
        const previous = resume.find((p) => p.id === plan.id);
        return previous
          ? {
              ...plan,
              server: plan.server || previous.server,
              direct: plan.direct || previous.direct,
              tunnels: [...new Set([...plan.tunnels, ...previous.tunnels])],
            }
          : plan;
      });
      this.state = {
        version: this.version,
        mode,
        phase: "running",
        progress: 5,
        detail: "已记录原有运行状态",
        plans,
        startedAt: Date.now(),
      };
      await this.save(this.state.detail, 5);
      if (mode === "upgrade") {
        const before = await this.agent.call<Bootstrap>("bootstrap");
        if (before.agentVersion !== this.version) {
          await this.save("重启管理服务，独立会话宿主与全部线路保持运行", 55);
          const next = await this.agent.reloadPreservingSessions();
          if (next.agentVersion !== this.version)
            throw new Error("新程序版本校验未通过");
          for (const snap of before.snapshots.filter((s) => s.pid)) {
            const deadline = Date.now() + 15000;
            let latest = next;
            while (!latest.samplerReady && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 500));
              latest = await this.agent.call<Bootstrap>("bootstrap");
            }
            const current = latest.snapshots.find((s) => s.id === snap.id);
            if (
              !current ||
              current.pid !== snap.pid ||
              !current.capabilities.command
            )
              throw new Error(
                "管理服务已更换，但会话控制验证尚未通过；未执行服务器或线路启停，请检查会话宿主",
              );
          }
        }
        await this.save("检查与整理历史版本数据", 95);
        await this.afterUpgrade();
      } else {
        await this.stop(plans);
        await this.save("停止管理后台", 55);
        await this.agent.stopWhenIdle();
      }
      this.state.phase = "complete";
      this.state.finishedAt = Date.now();
      await this.save(
        mode === "upgrade"
          ? "程序更新完成，服务器与线路未执行启停"
          : "程序与后台均已退出",
        100,
      );
    } catch (error: any) {
      const reason = error.message;
      let failure = reason;
      this.state = {
        ...this.state,
        phase: "failed",
        error: failure,
        detail: "操作未完成，请检查原因后重试",
      };
      await this.save(this.state.detail, this.state.progress);
      throw new Error(this.state.error);
    }
  }
}
