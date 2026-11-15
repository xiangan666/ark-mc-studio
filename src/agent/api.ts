import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import type { AgentEvent, Bootstrap, Schedule } from "../shared/types";
import { Store } from "./store";
import { Runtime } from "./runtime";
import { Jobs } from "./jobs";
import { Backups } from "./backups";
import { Content } from "./content";
import { Network } from "./network";
import { Installer } from "./install";
import { Tools } from "./tools";
import { CoreUpdates } from "./core-updates";
import { signalRouterSchema } from "../shared/network-control";
import { version as programVersion } from "../../package.json";
import { atomicWrite, exists, inside, json, safePath, sleep } from "./safe";

const id = z.string().uuid();
const rel = z.string().max(1024);
const abs = z.string().min(3).max(2000);
const command = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => !/[\r\n\0]/.test(v), "只能发送一条命令");
export const schemas = {
  bootstrap: z.object({}),
  "instances.import": z.object({ root: abs, tunnelRoot: abs.optional() }),
  "instances.rename": z.object({ id, name: z.string().min(1).max(100) }),
  "instances.remove": z.object({ id }),
  "server.action": z.object({
    id,
    action: z.enum(["start", "stop", "restart"]),
    countdown: z.number().int().min(0).max(300).default(0),
    tunnels: z.boolean().default(false),
  }),
  "console.logs": z.object({ id, after: z.number().int().min(0).default(0) }),
  "console.send": z.object({ id, command }),
  "metrics.history": z.object({
    id,
    hours: z.number().min(0.05).max(168).default(1),
  }),
  "players.get": z.object({ id }),
  "players.action": z.object({
    id,
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N}_ .-]+$/u),
    action: z.enum(["kick", "op", "deop", "allow-add", "allow-remove"]),
    reason: z.string().max(150).default("管理员操作"),
  }),
  "worlds.list": z.object({ id }),
  "worlds.size": z.object({ id, name: z.string().min(1).max(200) }),
  "worlds.select": z.object({ id, name: z.string().min(1).max(200) }),
  "worlds.export": z.object({ id, name: z.string().min(1).max(200) }),
  "worlds.import": z.object({
    id,
    source: abs,
    name: z.string().min(1).max(100),
  }),
  "packs.list": z.object({ id }),
  "packs.toggle": z.object({
    id,
    packId: z.string().max(300),
    enabled: z.boolean(),
  }),
  "packs.remove": z.object({ id, packId: z.string().max(300) }),
  "packs.install": z.object({
    id,
    source: abs,
    kind: z.enum(["auto", "plugin"]).default("auto"),
  }),
  "files.list": z.object({ id, path: rel.default("") }),
  "files.read": z.object({ id, path: rel }),
  "files.write": z.object({
    id,
    path: rel,
    text: z.string().max(2 * 1024 * 1024),
    revision: z.string().length(64),
  }),
  "config.get": z.object({ id }),
  "config.save": z.object({
    id,
    values: z.record(z.string(), z.string()),
    revision: z.string().length(64),
  }),
  "backups.list": z.object({ id }),
  "backups.create": z.object({ id, kind: z.enum(["world", "full"]) }),
  "backups.verify": z.object({ backupId: id }),
  "backups.restore": z.object({ backupId: id }),
  "backups.remove": z.object({ backupId: id }),
  "backups.path": z.object({ backupId: id }),
  "backups.manifest": z.object({ backupId: id }),
  "tunnels.get": z.object({ id }),
  "tunnels.attach": z.object({ id, root: abs }),
  "tunnels.prepare": z.object({ id }),
  "tools.list": z.object({ check: z.boolean().default(false) }),
  "tools.install": z.object({ tool: z.enum(["lolia", "sakura", "frp", "uv"]) }),
  "tools.organize": z.object({ id, source: abs.optional() }),
  "tools.router-runtime": z.object({}),
  "routers.save": z.object({
    id,
    config: signalRouterSchema,
  }),
  "tunnels.action": z.object({
    id,
    action: z.enum(["start", "stop", "reload"]),
    tunnelId: z.number().int().positive().optional(),
  }),
  "tunnels.target": z.object({
    id,
    tunnelId: z.number().int().positive(),
    ip: z.ipv4(),
  }),
  "tunnels.log": z.object({ id, tunnelId: z.number().int().positive() }),
  "tunnels.import": z.object({
    id,
    provider: z.enum(["lolia", "sakura", "frp-panel"]).default("lolia"),
    tunnelId: z.number().int().positive(),
    token: z.string().min(12).max(256),
  }),
  "tunnels.diagnose": z.object({
    id,
    host: z.string().min(1).max(253),
    advanced: z.boolean().default(false),
  }),
  "tunnels.quality.get": z.object({ id }),
  "tunnels.quality": z.object({
    id,
    signalId: z.number().int().positive().optional(),
  }),
  "schedules.save": z.object({
    id: id.optional(),
    instanceId: id,
    name: z.string().min(1).max(100),
    cron: z.string().min(5).max(100),
    action: z.enum(["backup", "restart", "start", "stop", "command"]),
    command: command.optional(),
    enabled: z.boolean(),
  }),
  "schedules.remove": z.object({ id }),
  "jobs.list": z.object({}),
  "jobs.cancel": z.object({ id }),
  "install.catalog": z.object({}),
  "core-updates.get": z.object({ id }),
  "core-updates.check": z.object({ id }),
  "core-updates.save": z.object({
    id,
    policy: z.object({
      autoCheck: z.boolean(),
      autoUpdate: z.boolean(),
      intervalHours: z.number().int().min(1).max(168),
      maintenanceTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      incompatibleEndstone: z.enum(["wait", "official-bds"]),
    }),
  }),
  "install.create": z.object({
    name: z.string().min(1).max(100),
    root: abs,
    core: z.enum(["bds", "endstone"]),
    version: z.string().max(50).optional(),
    zip: abs.optional(),
    port: z.number().int().min(1).max(65535),
    accepted: z.boolean(),
  }),
  "install.update": z.object({
    id,
    version: z.string().max(50).optional(),
    zip: abs.optional(),
    targetCore: z.enum(["bds", "endstone"]).optional(),
  }),
  "settings.save": z.object({
    theme: z.enum(["dark", "light"]).optional(),
    reducedMotion: z.boolean().optional(),
    notifications: z.boolean().optional(),
    backupRetention: z.number().int().min(1).max(100).optional(),
    historyDays: z.number().int().min(1).max(30).optional(),
    backupRoot: abs.optional(),
    closeToTray: z.boolean().optional(),
    launchAtLogin: z.boolean().optional(),
    commandFavorites: z.array(command).max(30).optional(),
  }),
  "diagnostics.export": z.object({ id: id.optional() }),
} as const;
export type Method = keyof typeof schemas;
export class API {
  runtime: Runtime;
  jobs: Jobs;
  backups: Backups;
  content: Content;
  network: Network;
  installer: Installer;
  tools: Tools;
  coreUpdates: CoreUpdates;
  private updatesTimer?: ReturnType<typeof setInterval>;
  private scheduler?: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    private emit: (event: AgentEvent) => void,
    resources: string,
    toolsRoot?: string,
  ) {
    this.runtime = new Runtime(store, emit, resources);
    this.jobs = new Jobs(store, emit);
    this.backups = new Backups(store, this.runtime);
    this.content = new Content(store, this.runtime);
    this.tools = new Tools(store, this.runtime, resources, toolsRoot);
    this.network = new Network(store, this.runtime, resources, this.tools.root);
    this.installer = new Installer(
      store,
      this.runtime,
      this.backups,
      this.content,
      resources,
    );
    this.coreUpdates = new CoreUpdates(
      store,
      this.runtime,
      this.jobs,
      this.installer,
    );
  }
  async init(discover = true) {
    if (discover) await this.runtime.discover();
    await this.runtime.init();
    this.updatesTimer = setInterval(() => {
      void this.coreUpdates
        .tick()
        .catch((error) =>
          this.runtime.activity(
            null,
            `核心更新调度失败：${error.message}`,
            "error",
          ),
        );
    }, 30000);
    for (const task of this.store.schedules()) {
      if (task.nextAt < Date.now()) {
        task.nextAt = this.next(task.cron);
        this.store.put("schedules", task);
      }
    }
    this.scheduler = setInterval(() => {
      void this.tick();
    }, 1000);
    for (const i of this.store.instances()) {
      if (this.store.get(`save-hold:${i.id}`, null)) {
        void (async () => {
          for (let n = 0; n < 30 && !this.runtime.samplerReady; n++)
            await sleep(500);
          await this.runtime.refresh();
          await this.runtime.command(i.id, "save resume", false);
        })()
          .then(() => this.store.set(`save-hold:${i.id}`, null))
          .catch(() =>
            this.runtime.activity(
              i.id,
              "检测到未结束的在线备份，请确认 save resume 已执行",
              "error",
            ),
          );
      }
    }
  }
  next(cron: string) {
    return CronExpressionParser.parse(cron, {
      currentDate: new Date(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
      .next()
      .getTime();
  }
  private async tick() {
    for (const task of this.store.schedules()) {
      if (!task.enabled || task.nextAt > Date.now()) continue;
      const missed = Date.now() - task.nextAt > 60000;
      task.lastAt = Date.now();
      task.nextAt = this.next(task.cron);
      if (
        missed ||
        this.store
          .jobs()
          .some(
            (j) =>
              j.type === `schedule:${task.id}` &&
              ["running", "queued"].includes(j.status),
          )
      ) {
        task.lastError = missed
          ? "电脑暂停期间错过本次时间，已跳过"
          : "同一计划任务仍在执行或排队，已跳过重复执行";
        this.store.put("schedules", task);
        continue;
      }
      task.lastError = undefined;
      this.store.put("schedules", task);
      this.jobs.run(
        task.instanceId,
        `schedule:${task.id}`,
        task.name,
        async (ctx) => {
          try {
            switch (task.action) {
              case "backup":
                return await this.backups.create(
                  task.instanceId,
                  "world",
                  ctx,
                  true,
                );
              case "restart":
                return await this.runtime.restart(
                  task.instanceId,
                  ctx.signal,
                  30,
                );
              case "start":
                return await this.runtime.start(task.instanceId, ctx.signal);
              case "stop":
                return await this.runtime.stop(task.instanceId);
              case "command":
                return await this.runtime.command(
                  task.instanceId,
                  task.command!,
                );
            }
          } catch (error: any) {
            task.lastError = error.message;
            this.store.put("schedules", task);
            throw error;
          }
        },
      );
    }
  }
  async bootstrap(): Promise<Bootstrap> {
    return {
      instances: this.store.instances(),
      snapshots: [...this.runtime.snapshots.values()],
      settings: this.store.settings(),
      jobs: this.store.jobs(),
      schedules: this.store.schedules(),
      activities: this.store.activities(),
      dataRoot: this.store.root,
      agentVersion: programVersion,
      features: { sessionHosts: true, gracefulShutdown: true },
      samplerReady: this.runtime.samplerReady,
    };
  }
  async call(method: string, raw: any = {}) {
    if (!Object.hasOwn(schemas, method)) throw new Error("不支持的管理操作");
    const a = (schemas as any)[method].parse(raw) as any;
    if (
      a.id &&
      method !== "schedules.remove" &&
      method !== "jobs.cancel" &&
      method !== "diagnostics.export"
    )
      this.store.instance(a.id);
    switch (method as Method) {
      case "bootstrap":
        return this.bootstrap();
      case "instances.import":
        return this.runtime.import(a.root, a.tunnelRoot);
      case "instances.rename": {
        const i = this.store.instance(a.id);
        i.name = a.name;
        this.store.put("instances", i);
        return i;
      }
      case "instances.remove": {
        if ((await this.runtime.get(a.id)).pid)
          throw new Error("请先正常停止实例再移除关联");
        this.store.delete("instances", a.id);
        this.runtime.snapshots.delete(a.id);
        return true;
      }
      case "server.action":
        return this.jobs.run(
          a.id,
          "lifecycle",
          a.action === "start"
            ? "启动服务器"
            : a.action === "stop"
              ? "保存并关闭服务器"
              : "重启服务器",
          async (ctx) => {
            ctx.update(10, "执行服务器操作");
            if (a.action === "stop") await this.runtime.stop(a.id);
            else if (a.action === "restart")
              await this.runtime.restart(a.id, ctx.signal, a.countdown);
            else await this.runtime.start(a.id, ctx.signal);
            if (
              a.tunnels &&
              a.action !== "stop" &&
              this.store.instance(a.id).tunnelRoot
            )
              await this.network.action(a.id, "start", undefined, ctx);
            return true;
          },
        );
      case "console.logs":
        return this.runtime.logs(a.id, a.after);
      case "console.send":
        if (this.jobs.busy(a.id))
          throw new Error("该实例正在执行维护任务，请等待任务结束");
        return this.runtime.command(a.id, a.command);
      case "metrics.history":
        return this.store.history(a.id, Date.now() - a.hours * 3600000);
      case "players.get":
        return {
          players: (await this.runtime.get(a.id)).players,
          allowlist: await json(
            path.join(this.store.instance(a.id).root, "allowlist.json"),
            [],
          ),
          permissions: await json(
            path.join(this.store.instance(a.id).root, "permissions.json"),
            [],
          ),
        };
      case "players.action": {
        if (this.jobs.busy(a.id)) throw new Error("实例维护中");
        const name = JSON.stringify(a.name);
        const commands: Record<string, string> = {
          kick: `kick ${name} ${JSON.stringify(a.reason.replace(/[\r\n]/g, ""))}`,
          op: `op ${name}`,
          deop: `deop ${name}`,
          "allow-add": `allowlist add ${name}`,
          "allow-remove": `allowlist remove ${name}`,
        };
        await this.runtime.command(a.id, commands[a.action]);
        return true;
      }
      case "worlds.list":
        return this.content.worlds(a.id);
      case "worlds.size":
        return this.content.worldSize(a.id, a.name);
      case "worlds.export":
        return this.jobs.run(a.id, "backup", `导出世界 ${a.name}`, (ctx) =>
          this.backups.create(a.id, "world", ctx, false, a.name),
        );
      case "worlds.select":
        return this.jobs.run(a.id, "world", "切换世界", async (ctx) => {
          ctx.update(10, "创建切换前快照");
          const s = await this.runtime.get(a.id);
          if (s.pid) throw new Error("请先正常关闭服务器再切换世界");
          if (
            await exists(
              path.join(this.store.instance(a.id).root, "worlds", s.world),
            )
          )
            await this.backups.create(a.id, "world", ctx);
          return this.content.selectWorld(a.id, a.name);
        });
      case "worlds.import":
        return this.jobs.run(a.id, "world", "导入世界", (ctx) =>
          this.content.importWorld(a.id, a.source, a.name, ctx),
        );
      case "packs.list":
        return this.content.packs(a.id);
      case "packs.toggle":
        return this.jobs.run(
          a.id,
          "pack",
          a.enabled ? "启用模组" : "停用模组",
          async () => this.content.togglePack(a.id, a.packId, a.enabled),
        );
      case "packs.remove":
        return this.jobs.run(a.id, "pack", "卸载模组", async () =>
          this.content.removePack(a.id, a.packId),
        );
      case "packs.install":
        return this.jobs.run(a.id, "pack", "安装模组或插件", (ctx) =>
          this.content.installPack(a.id, a.source, a.kind, ctx),
        );
      case "files.list":
        return this.content.files(a.id, a.path);
      case "files.read":
        return this.content.read(a.id, a.path);
      case "files.write":
        if (this.jobs.busy(a.id)) throw new Error("实例维护中");
        return this.content.write(a.id, a.path, a.text, a.revision);
      case "config.get":
        return this.content.config(a.id);
      case "config.save":
        if (this.jobs.busy(a.id)) throw new Error("实例维护中");
        return this.content.saveConfig(a.id, a.values, a.revision);
      case "backups.list":
        return this.store.backups(a.id);
      case "backups.create":
        return this.jobs.run(
          a.id,
          "backup",
          a.kind === "world" ? "备份当前世界" : "创建完整实例快照",
          (ctx) => this.backups.create(a.id, a.kind, ctx),
        );
      case "backups.verify": {
        const b = this.store.backups().find((b) => b.id === a.backupId);
        if (!b) throw new Error("备份不存在");
        return this.jobs.run(b.instanceId, "verify", "验证备份完整性", (ctx) =>
          this.backups.verify(a.backupId, ctx),
        );
      }
      case "backups.restore": {
        const b = this.store.backups().find((b) => b.id === a.backupId);
        if (!b) throw new Error("备份不存在");
        return this.jobs.run(b.instanceId, "restore", "恢复备份", (ctx) =>
          this.backups.restore(a.backupId, ctx),
        );
      }
      case "backups.remove":
        return this.backups.remove(a.backupId);
      case "backups.path":
        return this.backups.exportPath(a.backupId);
      case "backups.manifest":
        return this.backups.manifest(a.backupId);
      case "tunnels.get":
        return this.network.get(a.id);
      case "tunnels.attach":
        return this.jobs.run(a.id, "tools", "迁移并接管第三方工具", (ctx) =>
          this.tools.organize(a.id, a.root, ctx),
        );
      case "tunnels.prepare":
        return this.tools.prepareNetwork(a.id);
      case "tools.list":
        return this.tools.list(a.check);
      case "tools.install":
        return this.jobs.run(null, "tools", "下载并更新第三方工具", (ctx) =>
          this.tools.install(a.tool, ctx),
        );
      case "tools.organize":
        return this.jobs.run(a.id, "tools", "整理并接管实例工具", (ctx) =>
          this.tools.organize(a.id, a.source, ctx),
        );
      case "tools.router-runtime":
        return this.jobs.run(
          null,
          "tools",
          "准备通用信令转接层运行环境",
          (ctx) => this.tools.prepareRouterRuntime(ctx),
        );
      case "routers.save":
        return this.network.saveRouter(a.id, a.config);
      case "tunnels.action":
        return this.jobs.run(a.id, "tunnel", "管理隧道进程", (ctx) =>
          this.network.action(a.id, a.action, a.tunnelId, ctx),
        );
      case "tunnels.target":
        return this.network.updateTarget(a.id, a.tunnelId, a.ip);
      case "tunnels.log":
        return this.network.log(a.id, a.tunnelId);
      case "tunnels.import":
        return this.jobs.run(
          a.id,
          "tunnel",
          `导入 ${a.provider === "sakura" ? "SakuraFrp" : "Lolia"} 隧道`,
          async (ctx) => {
            await this.tools.prepareNetwork(a.id);
            return this.network.import(
              a.id,
              a.tunnelId,
              a.token,
              ctx,
              a.provider,
            );
          },
        );
      case "tunnels.diagnose":
        return this.jobs.run(
          a.id,
          "diagnose",
          `${a.advanced ? "高级" : "基础"}线路诊断`,
          (ctx) => this.network.diagnose(a.id, a.host, a.advanced, ctx),
        );
      case "tunnels.quality.get":
        return this.network.qualityReport(a.id);
      case "tunnels.quality": {
        const pending = this.store
          .jobs()
          .find(
            (j) =>
              j.instanceId === a.id &&
              j.type === "route-quality" &&
              ["running", "queued"].includes(j.status),
          );
        return (
          pending ||
          this.jobs.run(a.id, "route-quality", "检测内网穿透线路质量", (ctx) =>
            this.network.quality(a.id, a.signalId, ctx),
          )
        );
      }
      case "schedules.save": {
        this.store.instance(a.instanceId);
        if (a.action === "command" && !a.command)
          throw new Error("请输入计划执行的命令");
        const schedule: Schedule = {
          ...a,
          id: a.id || randomUUID(),
          nextAt: this.next(a.cron),
        };
        this.store.put("schedules", schedule);
        return schedule;
      }
      case "schedules.remove":
        this.store.delete("schedules", a.id);
        return true;
      case "jobs.list":
        return this.store.jobs();
      case "jobs.cancel":
        return this.jobs.cancel(a.id);
      case "install.catalog":
        return this.installer.catalog();
      case "core-updates.get":
        return this.coreUpdates.get(a.id);
      case "core-updates.check":
        return this.coreUpdates.checkedJob(a.id);
      case "core-updates.save":
        return this.coreUpdates.save(a.id, a.policy);
      case "install.create":
        return this.jobs.run(null, "install", "创建新服务器", (ctx) =>
          this.installer.create(a, ctx),
        );
      case "install.update":
        return this.jobs.run(
          a.id,
          "update",
          "手动更新服务器核心",
          async (ctx) => {
            const result = await this.installer.update(
              a.id,
              a.version,
              a.zip,
              ctx,
              a.targetCore,
            );
            this.coreUpdates.manualCompleted(a.id, result);
            return result;
          },
        );
      case "settings.save": {
        const settings = { ...this.store.settings(), ...a };
        if (a.backupRoot) {
          await fs.mkdir(a.backupRoot, { recursive: true });
          for (const i of this.store.instances())
            if (inside(i.root, a.backupRoot))
              throw new Error("备份目录不能位于实例内");
          if (
            this.store.backups().length &&
            a.backupRoot !== this.store.settings().backupRoot
          )
            throw new Error(
              "已有备份时请保留当前备份目录；可在新安装中选择位置",
            );
        }
        this.store.set("settings", settings);
        this.emit({ type: "settings", data: settings });
        return settings;
      }
      case "diagnostics.export":
        return {
          generatedAt: new Date().toISOString(),
          ...(await this.bootstrap()),
          network: a.id ? await this.network.get(a.id) : undefined,
          logs: a.id ? this.runtime.logs(a.id).slice(-150) : undefined,
          note: "凭证已脱敏。自动探针不等于真实 Minecraft 游戏登录。",
        };
    }
  }
  dispose() {
    if (this.scheduler) clearInterval(this.scheduler);
    if (this.updatesTimer) clearInterval(this.updatesTimer);
    this.coreUpdates.dispose();
    this.runtime.dispose();
    this.store.close();
  }
}
