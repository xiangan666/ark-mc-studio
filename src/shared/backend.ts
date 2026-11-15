import type { Bootstrap } from "./types";
import { version } from "../../package.json";

// A program release is one version. Old services must pass the explicit upgrade gate.
export const minimumBackend = version;
export function backendCompatible(version: string) {
  return version === minimumBackend;
}

export function backendReloadBlock(
  state: Pick<Bootstrap, "instances" | "snapshots" | "jobs" | "samplerReady">,
  preserveSessions = false,
) {
  if (state.jobs.some((job) => ["running", "queued"].includes(job.status)))
    return "请等待后台任务完成后再重载";
  if (state.instances.length && !state.samplerReady)
    return "进程采样尚未就绪，暂不能确认服务器已停止";
  if (
    state.instances.some((instance) => {
      const snapshot = state.snapshots.find((item) => item.id === instance.id);
      if (!snapshot) return true;
      if (!snapshot.pid) return snapshot.status !== "stopped";
      return !(
        preserveSessions &&
        snapshot.capabilities?.command &&
        (snapshot.capabilities.sessionHost || instance.adapter === "legacy") &&
        snapshot.status === "running"
      );
    })
  )
    return preserveSessions
      ? "当前会话尚未使用独立宿主，请手动完成首次版本切换；程序未执行任何停服或线路停止操作"
      : "请先正常关闭所有服务器，再重载管理后台；隧道可保持运行";
  return "";
}
