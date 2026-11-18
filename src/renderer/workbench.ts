import type { Job, Schedule, Snapshot } from "../shared/types";
import { selectRoutes, type RouteRow } from "./analysis";

export function startBlocker(
  snapshot: Pick<Snapshot, "status" | "pid"> | undefined,
  samplerReady: boolean,
  busy: boolean,
  disconnected: boolean,
) {
  if (disconnected) return "管理后台尚未连接";
  if (busy) return "当前实例有任务正在执行";
  if (!samplerReady || !snapshot) return "等待后台确认进程状态";
  if (snapshot.status !== "stopped" || snapshot.pid !== null)
    return "尚未确认服务器已停止";
  return "";
}
export const taskTargets = {
  active: "tasks-instance-active",
  issues: "tasks-instance-issues",
  history: "tasks-instance-history",
} as const;
export function taskFocus(target: string) {
  if (target === taskTargets.active) return { tab: "active", result: "all" };
  if (target === taskTargets.issues)
    return { tab: "history", result: "issues" };
  if (target === taskTargets.history) return { tab: "history", result: "all" };
  return null;
}
export function instanceBrief(
  id: string,
  jobs: Job[],
  schedules: Schedule[],
  routes: RouteRow[],
  now = Date.now(),
) {
  const own = jobs.filter((job) => job.instanceId === id);
  const active = own.filter(
    (job) => job.status === "running" || job.status === "queued",
  ).length;
  const issues = own.filter(
    (job) => job.status === "failed" || job.status === "interrupted",
  ).length;
  const next = schedules
    .filter(
      (plan) =>
        plan.instanceId === id &&
        plan.enabled &&
        Number.isFinite(plan.nextAt) &&
        plan.nextAt >= now,
    )
    .sort((a, b) => a.nextAt - b.nextAt)[0];
  return {
    active,
    issues,
    next,
    attention: selectRoutes(routes, "", "attention").length,
  };
}
