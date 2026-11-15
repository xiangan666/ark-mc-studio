import type {
  CoreUpdatePolicy,
  CoreUpdateReport,
  CoreUpdateState,
  Snapshot,
} from "../shared/types";
import { Store } from "./store";
import { Runtime } from "./runtime";
import { Jobs, type JobContext } from "./jobs";
import { Installer } from "./install";
import { compareVersions, endstoneCompatibility } from "./releases";
import { errorText } from "./safe";

export const defaultCoreUpdatePolicy: CoreUpdatePolicy = {
  autoCheck: false,
  autoUpdate: false,
  intervalHours: 6,
  maintenanceTime: "04:00",
  incompatibleEndstone: "wait",
};

export function nextMaintenance(time: string, now = Date.now()) {
  const [hour, minute] = time.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function autoUpdateBlock(
  snapshot: Snapshot,
  telemetryFresh: boolean,
): string | undefined {
  if (!telemetryFresh) return "进程采样尚未就绪或已过期";
  if (!["running", "stopped"].includes(snapshot.status))
    return "实例尚未就绪或由外部程序运行";
  if (snapshot.pid && !snapshot.capabilities.command)
    return "当前后台不能正常保存并关闭此实例";
  if (snapshot.pid && snapshot.metric.players == null)
    return "无法确认在线人数";
  if (snapshot.pid && snapshot.metric.players! > 0)
    return `仍有 ${snapshot.metric.players} 位玩家在线`;
}

class DeferredUpdate extends Error {}

export class CoreUpdates {
  private ticking = false;
  private disposed = false;
  constructor(
    private store: Store,
    private runtime: Runtime,
    private jobs: Jobs,
    private installer: Installer,
  ) {}

  get(id: string): CoreUpdateState {
    this.store.instance(id);
    const state = this.store.get<Partial<CoreUpdateState>>(
      `core-updates:${id}`,
      {},
    );
    return {
      ...state,
      policy: { ...defaultCoreUpdatePolicy, ...state.policy },
      report: state.report || null,
    };
  }
  private patch(id: string, changes: Partial<CoreUpdateState>) {
    if (this.disposed) return;
    this.store.set(`core-updates:${id}`, { ...this.get(id), ...changes });
  }
  save(id: string, policy: CoreUpdatePolicy) {
    const previous = this.get(id);
    if (policy.autoUpdate) policy = { ...policy, autoCheck: true };
    this.patch(id, {
      policy,
      nextCheckAt: policy.autoCheck ? Date.now() : undefined,
      nextUpdateAt: policy.autoUpdate
        ? nextMaintenance(policy.maintenanceTime)
        : undefined,
      maintenanceWindowAt: policy.autoUpdate
        ? nextMaintenance(policy.maintenanceTime)
        : undefined,
      lastOutcome: previous.lastOutcome,
    });
    this.runtime.activity(
      id,
      `核心更新策略已保存：自动检查${policy.autoCheck ? "开启" : "关闭"}，自动安装${policy.autoUpdate ? `每天 ${policy.maintenanceTime}` : "关闭"}`,
    );
    return this.get(id);
  }
  async check(id: string, signal?: AbortSignal): Promise<CoreUpdateReport> {
    const instance = this.store.instance(id);
    const snapshot = await this.runtime.get(id);
    let report: CoreUpdateReport = {
      checkedAt: Date.now(),
      core: instance.core,
      targetCore: instance.core,
      currentBds: snapshot.version,
      currentEndstone: snapshot.endstoneVersion,
      status: "unknown",
      updateAvailable: false,
      detail: "正在读取官方版本",
      releaseUrl:
        instance.core === "endstone"
          ? "https://github.com/EndstoneMC/endstone/releases"
          : "https://www.minecraft.net/download/server/bedrock",
    };
    try {
      const catalog = await this.installer.catalog();
      signal?.throwIfAborted();
      report.latestBds = catalog.bds?.version;
      if (instance.core === "bds") {
        if (!catalog.bds)
          throw new Error(
            "BDS 官方版本目录暂不可用，请稍后重试或手动导入官方 ZIP",
          );
        const comparison = compareVersions(
          catalog.bds.version,
          snapshot.version,
        );
        report.targetCore = "bds";
        if (comparison == null)
          report.detail = "当前 BDS 版本未识别，无法判断是否有更新；请手动核对";
        else {
          report.status = comparison > 0 ? "available" : "current";
          report.updateAvailable = comparison > 0;
          report.compatibleBds = catalog.bds.version;
          report.detail =
            comparison > 0
              ? "发现官方 Windows BDS 正式版更新"
              : comparison === 0
                ? "已是官方当前正式版"
                : "当前版本高于官方目录版本，保留现用版本";
        }
      } else {
        const version = catalog.endstone?.version;
        if (!version)
          throw new Error(
            "未找到适用于 Windows / Python 3.13 的 Endstone 正式发行包",
          );
        report.latestEndstone = version;
        // The tagged official stub declares the Minecraft version; the official
        // bedrock-server-data metadata selects its exact Windows binary + hash.
        let compatible = this.store.get<{ at: number; version: string } | null>(
          `endstone-compatibility:${version}`,
          null,
        );
        if (!compatible || Date.now() - compatible.at > 6 * 3600000) {
          const binary = await endstoneCompatibility(version, signal);
          compatible = { at: Date.now(), version: binary.version };
          if (!this.disposed)
            this.store.set(`endstone-compatibility:${version}`, compatible);
        }
        report.compatibleBds = compatible.version;
        const endstoneDiff = compareVersions(version, snapshot.endstoneVersion);
        const bdsDiff = compareVersions(compatible.version, snapshot.version);
        const officialAhead =
          !!catalog.bds &&
          compareVersions(catalog.bds.version, compatible.version) === 1;
        const policy = this.get(id).policy;
        if (
          officialAhead &&
          policy.incompatibleEndstone === "official-bds" &&
          catalog.bds
        ) {
          report.targetCore = "bds";
          report.releaseUrl =
            "https://www.minecraft.net/download/server/bedrock";
          const officialDiff = compareVersions(
            catalog.bds.version,
            snapshot.version,
          );
          if (officialDiff == null) {
            report.detail =
              "已选择官方 BDS 路线，但当前 BDS 版本未识别；请手动核对后切换";
          } else {
            report.updateAvailable = officialDiff >= 0;
            report.status = report.updateAvailable ? "available" : "current";
            report.detail = report.updateAvailable
              ? `已选择暂时使用官方 BDS ${catalog.bds.version}；Endstone 插件在该核心下暂停加载`
              : `官方 BDS ${catalog.bds.version} 低于当前配套 BDS ${snapshot.version}，拒绝降级`;
          }
        } else {
          report.targetCore = "endstone";
          if (endstoneDiff == null || bdsDiff == null)
            report.detail =
              "已取得兼容组合，但当前核心版本未完全识别；请手动核对后更新";
          else if (endstoneDiff < 0 || bdsDiff < 0) {
            report.status = "current";
            report.detail =
              "当前核心包含比官方兼容组合更新的组件，保留现用版本，不自动降级";
          } else {
            report.updateAvailable = endstoneDiff > 0 || bdsDiff > 0;
            report.status = report.updateAvailable ? "available" : "current";
            report.detail = report.updateAvailable
              ? `可更新为 Endstone ${version} / BDS ${compatible.version}`
              : "已是 Endstone 当前兼容组合";
          }
          if (officialAhead)
            report.detail += `。BDS ${catalog.bds!.version} 尚未列入该 Endstone 的兼容组合，默认等待 Endstone 官方适配`;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      report = {
        ...report,
        status: "unavailable",
        updateAvailable: false,
        detail: "本次未能确认更新，请重试或查看官方发行说明",
        error: errorText(error),
      };
    }
    const previous = this.get(id).report;
    this.patch(id, { report });
    if (
      report.updateAvailable &&
      (!previous?.updateAvailable ||
        previous.latestEndstone !== report.latestEndstone ||
        previous.compatibleBds !== report.compatibleBds)
    )
      this.runtime.activity(id, `发现核心更新：${report.detail}`);
    return report;
  }
  checkedJob(id: string) {
    const existing = this.store
      .jobs()
      .find(
        (j) =>
          j.instanceId === id &&
          j.type === "core-check" &&
          ["running", "queued"].includes(j.status),
      );
    return (
      existing ||
      this.jobs.run(id, "core-check", "检查核心更新", async (ctx) => {
        ctx.update(10, "读取官方发行目录与兼容元数据");
        const report = await this.check(id, ctx.signal);
        if (report.error) throw new Error(report.error);
        return report;
      })
    );
  }
  manualCompleted(id: string, result: any) {
    this.patch(id, {
      report: null,
      nextCheckAt: this.get(id).policy.autoCheck ? Date.now() : undefined,
      lastOutcome: {
        at: Date.now(),
        detail: `手动更新完成：${result.core === "endstone" ? `Endstone ${result.endstoneVersion} / ` : "官方 BDS "}BDS ${result.version}，恢复点 ${result.rollbackBackup}`,
      },
    });
  }
  private outcome(id: string, detail: string, jobId?: string) {
    this.patch(id, { lastOutcome: { at: Date.now(), detail, jobId } });
  }
  private async automatic(id: string, scheduledAt: number, ctx: JobContext) {
    try {
      const assertIdle = async () => {
        if (!this.get(id).policy.autoUpdate)
          throw new DeferredUpdate("自动安装已关闭");
        if (Date.now() > scheduledAt + 3600000)
          throw new DeferredUpdate("本次维护窗口已结束");
        const reason = autoUpdateBlock(
          await this.runtime.get(id),
          this.runtime.telemetryFresh,
        );
        if (reason) throw new DeferredUpdate(reason);
      };
      await assertIdle();
      ctx.update(4, "检查官方更新并确认兼容组合");
      const report = await this.check(id, ctx.signal);
      if (report.error) throw new Error(report.error);
      if (!report.updateAvailable || report.status !== "available") {
        this.outcome(id, report.detail, ctx.id);
        return { skipped: true, reason: report.detail };
      }
      const instance = this.store.instance(id);
      const targetCore = report.targetCore ?? instance.core;
      if (
        targetCore !== instance.core &&
        !(
          instance.core === "endstone" &&
          targetCore === "bds" &&
          this.get(id).policy.incompatibleEndstone === "official-bds"
        )
      ) {
        this.outcome(id, "核心类型需要手动确认；自动更新保持当前核心", ctx.id);
        return { skipped: true, reason: "核心类型需要手动确认" };
      }
      const result = await this.installer.update(
        id,
        targetCore === "endstone" ? report.latestEndstone : report.latestBds,
        undefined,
        ctx,
        targetCore,
        async (receipt) => {
          await assertIdle();
          if (
            targetCore === "endstone" &&
            (receipt.version !== report.compatibleBds ||
              receipt.endstoneVersion !== report.latestEndstone)
          )
            throw new Error(
              "下载后的核心与检测到的兼容组合不一致，已保留现用版本",
            );
          if (targetCore === "bds" && receipt.version !== report.latestBds)
            throw new Error("下载后的 BDS 与检查到的官方版本不一致");
        },
      );
      this.outcome(
        id,
        `自动更新完成：${result.core === "endstone" ? `Endstone ${result.endstoneVersion} / ` : "官方 BDS "}BDS ${result.version}；恢复点 ${result.rollbackBackup}`,
        ctx.id,
      );
      await this.check(id, ctx.signal);
      return result;
    } catch (error) {
      if (error instanceof DeferredUpdate) {
        const state = this.get(id),
          now = Date.now();
        if (state.policy.autoUpdate && now + 300000 < scheduledAt + 3600000)
          this.patch(id, {
            nextUpdateAt: now + 300000,
            maintenanceWindowAt: scheduledAt,
          });
        this.outcome(id, `自动更新已延后：${error.message}`, ctx.id);
        return { skipped: true, reason: error.message };
      }
      const state = this.get(id);
      this.patch(id, {
        policy: { ...state.policy, autoUpdate: false },
        nextUpdateAt: undefined,
      });
      this.outcome(
        id,
        `自动更新失败并暂停自动安装：${errorText(error)}`,
        ctx.id,
      );
      throw error;
    }
  }
  async tick(now = Date.now()) {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      for (const instance of this.store.instances()) {
        const state = this.get(instance.id),
          id = instance.id;
        if (
          state.policy.autoUpdate &&
          (state.nextUpdateAt || Infinity) <= now
        ) {
          const scheduledAt = state.maintenanceWindowAt || state.nextUpdateAt!;
          const next = nextMaintenance(state.policy.maintenanceTime, now);
          this.patch(id, {
            nextUpdateAt: next,
            maintenanceWindowAt: next,
            nextCheckAt: now + state.policy.intervalHours * 3600000,
          });
          if (now > scheduledAt + 3600000) {
            this.outcome(
              id,
              "电脑暂停期间错过维护窗口，已安排到下一次维护时间",
            );
            continue;
          }
          const busy = this.store
            .jobs()
            .some(
              (j) =>
                j.instanceId === id && ["running", "queued"].includes(j.status),
            );
          if (busy) {
            if (now + 300000 < scheduledAt + 3600000)
              this.patch(id, {
                nextUpdateAt: now + 300000,
                maintenanceWindowAt: scheduledAt,
              });
            this.outcome(id, "实例存在其他任务，自动更新已延后");
            continue;
          }
          this.jobs.run(id, "auto-core-update", "自动更新服务器核心", (ctx) =>
            this.automatic(id, scheduledAt, ctx),
          );
        } else if (state.policy.autoCheck && (state.nextCheckAt || 0) <= now) {
          this.patch(id, {
            nextCheckAt: now + state.policy.intervalHours * 3600000,
          });
          this.checkedJob(id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  dispose() {
    this.disposed = true;
  }
}
