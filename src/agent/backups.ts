import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { ZipArchive } from "archiver";
import type { Backup, Core } from "../shared/types";
import { Store } from "./store";
import { Runtime } from "./runtime";
import type { JobContext } from "./jobs";
import {
  atomicWrite,
  availableBytes,
  copyLimited,
  exists,
  extractZip,
  fileHash,
  inside,
  json,
  safePath,
  sleep,
  validateRelative,
  walk,
} from "./safe";

interface Manifest {
  schema: 1;
  instanceId: string;
  kind: "world" | "full";
  world: string;
  version: string;
  createdAt: number;
  core?: Core;
  preferredCore?: Core;
  managedPython?: string;
  files: { path: string; size: number; sha256: string }[];
}
const excluded = new Set([
  "logs",
  "backups",
  ".git",
  "__pycache__",
  "LOCK",
  ".server-lock",
  ".server-state.json",
  ".console-command.json",
  ".ark-restore",
  ".DS_Store",
]);
export function parseSaveQuery(
  text: string,
  world: string,
): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/^\[[^\]]+\]:\s*/, "").trim();
    for (const match of clean.matchAll(
      /(?:^|,\s*)([^,\r\n]+?):\s*(\d+)(?=\s*,|\s*$)/g,
    )) {
      let relative = match[1].trim().replace(/\\/g, "/");
      if (relative.startsWith(world + "/")) relative = "worlds/" + relative;
      if (!relative.startsWith(`worlds/${world}/`)) continue;
      relative = validateRelative(relative);
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size < 0)
        throw new Error("服务端返回了无效的备份长度");
      out.push({ path: relative, size });
    }
  }
  return [...new Map(out.map((f) => [f.path, f])).values()];
}
export class Backups {
  constructor(
    private store: Store,
    private runtime: Runtime,
  ) {}
  private file(id: string) {
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error("无效的备份编号");
    return path.join(this.store.settings().backupRoot, `${id}.zip`);
  }
  async create(
    instanceId: string,
    kind: "world" | "full",
    ctx: JobContext,
    automatic = false,
    worldName?: string,
  ): Promise<Backup> {
    const instance = this.store.instance(instanceId);
    const snap = { ...(await this.runtime.get(instanceId)) };
    const activeWorld = snap.world;
    if (worldName) {
      validateRelative(worldName);
      if (worldName.includes("/") || worldName.includes("\\"))
        throw new Error("世界名称无效");
      await safePath(instance.root, `worlds/${worldName}`);
      snap.world = worldName;
    }
    const id = randomUUID();
    const root = this.store.settings().backupRoot;
    await fs.mkdir(root, { recursive: true });
    if (inside(instance.root, root))
      throw new Error("备份目录必须位于实例目录外");
    const stage = path.join(root, `.staging-${id}`);
    await fs.mkdir(stage);
    let held = false;
    const restart = kind === "full" && !!snap.pid;
    this.runtime.setMaintenance(instanceId, true);
    try {
      ctx.update(3, "准备一致性备份");
      let files: { path: string; size: number }[] = [];
      if (kind === "full") {
        if (restart) await this.runtime.stop(instanceId);
        files = await walk(instance.root, excluded);
      } else if (snap.pid && snap.world === activeWorld) {
        this.store.set(`save-hold:${instanceId}`, { at: Date.now() });
        held = true;
        await this.runtime.command(instanceId, "save hold", false);
        for (let n = 0; n < 30; n++) {
          ctx.signal.throwIfAborted();
          await sleep(1000, ctx.signal);
          try {
            const text = await this.runtime.waitLines(
              instanceId,
              "save query",
              (text) =>
                parseSaveQuery(text, snap.world).length > 0 ||
                /not ready|not yet|尚未|未准备/i.test(text),
              4000,
            );
            files = parseSaveQuery(text, snap.world);
            if (files.length) break;
          } catch (error) {
            if (n === 29) throw error;
          }
        }
        if (!files.length)
          throw new Error("未取得官方备份文件清单，请使用停服全量快照");
      } else {
        const world = await safePath(instance.root, `worlds/${snap.world}`);
        files = (await walk(world)).map((f) => ({
          ...f,
          path: path.join("worlds", snap.world, f.path),
        }));
      }
      if (!files.length) throw new Error("没有可备份的文件");
      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      if ((await availableBytes(root)) < bytes * 2 + 256 * 1024 ** 2)
        throw new Error("磁盘空间不足以准备并校验这份备份");
      const manifest: Manifest = {
        schema: 1,
        instanceId,
        kind,
        world: snap.world,
        version: snap.version,
        createdAt: Date.now(),
        core: instance.core,
        preferredCore: instance.preferredCore ?? instance.core,
        files: [],
      };
      const toolsRoot = this.store.get<string | null>(
        "managed-tools-root",
        null,
      );
      if (
        kind === "full" &&
        instance.python &&
        toolsRoot &&
        inside(path.join(toolsRoot, "runtimes", "endstone"), instance.python)
      )
        manifest.managedPython = path.relative(toolsRoot, instance.python);
      for (let n = 0; n < files.length; n++) {
        ctx.signal.throwIfAborted();
        const file = files[n];
        const source = await safePath(instance.root, file.path);
        const target = await safePath(stage, file.path, true);
        await copyLimited(source, target, file.size, ctx.signal);
        manifest.files.push({
          path: file.path.replace(/\\/g, "/"),
          size: file.size,
          sha256: await fileHash(target),
        });
        if (n % 25 === 0 || n === files.length - 1)
          ctx.update(
            8 + Math.round(((n + 1) / files.length) * 65),
            `复制并校验 ${n + 1} / ${files.length} 个文件`,
          );
      }
      if (held) {
        await this.runtime.command(instanceId, "save resume", false);
        held = false;
        this.store.set(`save-hold:${instanceId}`, null);
      }
      await atomicWrite(
        path.join(stage, "arkmc-manifest.json"),
        JSON.stringify(manifest, null, 2),
      );
      ctx.update(77, "压缩并生成完整性校验");
      const output = this.file(id) + ".partial";
      await new Promise<void>((resolve, reject) => {
        const destination = createWriteStream(output, { flags: "wx" });
        const archive = new ZipArchive({ zlib: { level: 3 } });
        const abort = () => {
          archive.abort();
          destination.destroy(new Error("任务已取消"));
        };
        ctx.signal.addEventListener("abort", abort, { once: true });
        archive.on("error", reject);
        destination.on("error", reject);
        destination.on("close", () => {
          ctx.signal.removeEventListener("abort", abort);
          resolve();
        });
        archive.pipe(destination);
        archive.directory(stage, false);
        void archive.finalize();
      });
      ctx.signal.throwIfAborted();
      const sha256 = await fileHash(output);
      await fs.rename(output, this.file(id));
      await atomicWrite(
        this.file(id) + ".manifest.json",
        JSON.stringify(manifest),
      );
      const stat = await fs.stat(this.file(id));
      const backup: Backup = {
        id,
        instanceId,
        kind,
        name: `${snap.world} · ${kind === "world" ? "世界备份" : "完整快照"}`,
        at: manifest.createdAt,
        size: stat.size,
        files: files.length,
        sha256,
        world: snap.world,
        version: snap.version,
        verified: true,
        automatic,
      };
      this.store.put("backups", backup);
      if (automatic) {
        const older = this.store
          .backups(instanceId)
          .filter((b) => b.automatic && b.kind === kind)
          .slice(this.store.settings().backupRetention);
        for (const old of older) {
          await fs.rm(this.file(old.id), { force: true });
          await fs.rm(this.file(old.id) + ".manifest.json", { force: true });
          this.store.delete("backups", old.id);
        }
      }
      ctx.update(100, "备份已完成并校验");
      return backup;
    } finally {
      if (held) {
        try {
          await this.runtime.command(instanceId, "save resume", false);
          this.store.set(`save-hold:${instanceId}`, null);
        } catch {
          this.runtime.activity(
            instanceId,
            "恢复自动保存失败，请立即发送 save resume 并检查控制台",
            "error",
          );
        }
      }
      if (inside(root, stage))
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      await fs.rm(this.file(id) + ".partial", { force: true }).catch(() => {});
      this.runtime.setMaintenance(instanceId, false);
      if (restart && !(await this.runtime.get(instanceId).then((s) => s.pid)))
        await this.runtime
          .start(instanceId)
          .catch((error) =>
            this.runtime.activity(
              instanceId,
              `备份后重新启动失败：${error.message}`,
              "error",
            ),
          );
    }
  }
  async verify(id: string, ctx: JobContext) {
    const backup = this.store.backups().find((b) => b.id === id);
    if (!backup) throw new Error("备份不存在");
    ctx.update(20, "校验压缩包 SHA-256");
    if ((await fileHash(this.file(id))) !== backup.sha256) {
      backup.verified = false;
      this.store.put("backups", backup);
      throw new Error("备份文件已损坏，校验值不一致");
    }
    const temp = path.join(this.store.root, "work", randomUUID());
    try {
      await extractZip(this.file(id), temp, ctx.signal);
      const manifest = await this.readManifest(temp, backup);
      for (let n = 0; n < manifest.files.length; n++) {
        ctx.signal.throwIfAborted();
        const item = manifest.files[n];
        const file = await safePath(temp, item.path);
        if (
          (await fs.stat(file)).size !== item.size ||
          (await fileHash(file)) !== item.sha256
        )
          throw new Error(`备份文件损坏：${item.path}`);
        if (n % 25 === 0)
          ctx.update(
            25 + Math.round((n / manifest.files.length) * 70),
            `校验 ${n + 1}/${manifest.files.length}`,
          );
      }
      backup.verified = true;
      await atomicWrite(
        this.file(id) + ".manifest.json",
        JSON.stringify(manifest),
      );
      this.store.put("backups", backup);
      return true;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  private async readManifest(temp: string, backup: Backup) {
    const manifest = await json<Manifest | null>(
      path.join(temp, "arkmc-manifest.json"),
      null,
    );
    if (
      !manifest ||
      manifest.schema !== 1 ||
      manifest.instanceId !== backup.instanceId ||
      manifest.kind !== backup.kind ||
      (manifest.core !== undefined &&
        !["bds", "endstone"].includes(manifest.core)) ||
      (manifest.preferredCore !== undefined &&
        !["bds", "endstone"].includes(manifest.preferredCore)) ||
      !Array.isArray(manifest.files)
    )
      throw new Error("备份清单不匹配");
    for (const file of manifest.files) {
      validateRelative(file.path);
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !/^[0-9a-f]{64}$/.test(file.sha256)
      )
        throw new Error("无效的备份清单");
    }
    return manifest;
  }
  async restore(id: string, ctx: JobContext) {
    const backup = this.store.backups().find((b) => b.id === id);
    if (!backup) throw new Error("备份不存在");
    await this.verify(id, ctx);
    const i = this.store.instance(backup.instanceId);
    const originalInstance = { ...i };
    let restoredPython: string | undefined;
    if (backup.kind === "full") {
      const manifest = await this.manifest(id);
      if (manifest.managedPython) {
        const toolsRoot = this.store.get<string | null>(
          "managed-tools-root",
          null,
        );
        if (!toolsRoot) throw new Error("恢复需要原管理程序的运行环境目录");
        restoredPython = await safePath(toolsRoot, manifest.managedPython);
        if (
          !inside(
            path.join(toolsRoot, "runtimes", "endstone"),
            restoredPython,
          ) ||
          path.basename(restoredPython).toLowerCase() !== "python.exe"
        )
          throw new Error("备份关联的运行环境路径无效");
        if (!(await exists(restoredPython)))
          throw new Error(
            "备份关联的 Endstone 运行环境缺失，请保留 managed-tools 目录",
          );
      }
    }
    const wasRunning = !!(await this.runtime.get(i.id)).pid;
    if (wasRunning) await this.runtime.stop(i.id);
    let prepared = false;
    let transactionComplete = false;
    const temp = path.join(this.store.root, "work", randomUUID());
    const rollback = path.join(i.root, `.ark-restore-${randomUUID()}`);
    const moved: string[] = [];
    const installed: string[] = [];
    try {
      ctx.update(5, "创建恢复前完整快照");
      await this.create(i.id, "full", {
        ...ctx,
        update: (p, d) => ctx.update(Math.round(p * 0.4), d),
      });
      ctx.update(45, "展开目标备份");
      await extractZip(this.file(id), temp, ctx.signal);
      const manifest = await this.readManifest(temp, backup);
      ctx.signal.throwIfAborted();
      await fs.mkdir(rollback);
      prepared = true;
      const targetEntries =
        backup.kind === "world"
          ? [path.join("worlds", backup.world)]
          : [...new Set(manifest.files.map((f) => f.path.split("/")[0]))];
      const currentEntries =
        backup.kind === "full"
          ? (await fs.readdir(i.root)).filter(
              (name) =>
                !excluded.has(name) && !name.startsWith(".ark-restore-"),
            )
          : [];
      const entries = [...new Set([...targetEntries, ...currentEntries])];
      for (const rel of entries) {
        const destination = await safePath(i.root, rel, true);
        const source = await safePath(temp, rel, true);
        const previous = path.join(rollback, rel);
        await fs.mkdir(path.dirname(previous), { recursive: true });
        if (await exists(destination)) {
          await fs.rename(destination, previous);
          moved.push(rel);
        }
        if (!(await exists(source))) continue;
        await fs.mkdir(path.dirname(destination), { recursive: true });
        try {
          await fs.cp(source, destination, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          installed.push(rel);
        } catch (error) {
          await fs.rm(destination, { recursive: true, force: true });
          throw error;
        }
      }
      if (backup.kind === "full") {
        const metadata = await this.manifest(id);
        await this.runtime.saveInstance({
          ...i,
          core: metadata.core ?? i.core,
          preferredCore: metadata.preferredCore,
          python: restoredPython,
          version: metadata.version,
        });
      }
      ctx.update(92, "恢复完成，保留恢复前快照");
      if (wasRunning) await this.runtime.start(i.id);
      transactionComplete = true;
      return { restored: backup.name };
    } catch (error) {
      if (prepared) {
        if ((await this.runtime.get(i.id)).pid) await this.runtime.stop(i.id);
        await this.runtime.saveInstance(originalInstance);
        for (const rel of installed)
          await fs.rm(await safePath(i.root, rel, true), {
            recursive: true,
            force: true,
          });
        for (const rel of [...moved].reverse()) {
          const destination = await safePath(i.root, rel, true);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.rename(path.join(rollback, rel), destination);
        }
        transactionComplete = true;
      }
      throw error;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
      if (prepared && transactionComplete)
        await fs.rm(rollback, { recursive: true, force: true });
      else if (prepared)
        this.runtime.activity(i.id, `恢复前文件副本保留于 ${rollback}`);
      if (wasRunning && !(await this.runtime.get(i.id)).pid)
        await this.runtime.start(i.id).catch(() => {});
    }
  }
  async remove(id: string) {
    const backup = this.store.backups().find((b) => b.id === id);
    if (!backup) throw new Error("备份不存在");
    await fs.rm(this.file(id));
    await fs.rm(this.file(id) + ".manifest.json", { force: true });
    this.store.delete("backups", id);
    return true;
  }
  exportPath(id: string) {
    if (!this.store.backups().some((b) => b.id === id))
      throw new Error("备份不存在");
    return this.file(id);
  }
  async manifest(id: string) {
    const backup = this.store.backups().find((b) => b.id === id);
    if (!backup) throw new Error("备份不存在");
    const data = await json<Manifest | null>(
      this.file(id) + ".manifest.json",
      null,
    );
    if (data) return data;
    throw new Error("该备份没有独立清单，请先执行完整性校验");
  }
}
