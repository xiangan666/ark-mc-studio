import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileEntry, Pack, TextFile, World } from "../shared/types";
import { Store } from "./store";
import { Runtime } from "./runtime";
import type { JobContext } from "./jobs";
import {
  atomicWrite,
  digest,
  exists,
  extractZip,
  json,
  patchProperties,
  properties,
  safePath,
  validateProperties,
  walk,
} from "./safe";

const editable =
  /\.(json|toml|ini|ya?ml|properties|txt|md|conf|cfg|lang|mcfunction)$/i;
export class Content {
  constructor(
    private store: Store,
    private runtime: Runtime,
  ) {}
  async files(id: string, rel = ""): Promise<FileEntry[]> {
    const root = this.store.instance(id).root;
    const directory = await safePath(root, rel);
    const list = await fs.readdir(directory, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const item of list) {
      if (
        item.isSymbolicLink() ||
        [".venv", ".git", "__pycache__"].includes(item.name) ||
        item.name.startsWith(".ark-")
      )
        continue;
      const child = path.join(rel, item.name);
      try {
        const stat = await fs.stat(await safePath(root, child));
        result.push({
          name: item.name,
          path: child.replace(/\\/g, "/"),
          directory: item.isDirectory(),
          size: stat.size,
          modified: stat.mtimeMs,
        });
      } catch {}
    }
    return result.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, "zh-CN"),
    );
  }
  async read(id: string, rel: string): Promise<TextFile> {
    if (!editable.test(rel)) throw new Error("该文件类型不支持文本编辑");
    const file = await safePath(this.store.instance(id).root, rel);
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024)
      throw new Error("文本文件超过 2 MB，请使用外部编辑器");
    const buffer = await fs.readFile(file);
    return {
      path: rel,
      text: buffer.toString("utf8").replace(/^\uFEFF/, ""),
      revision: digest(buffer),
      bom: buffer.subarray(0, 3).equals(Buffer.from([239, 187, 191])),
    };
  }
  async write(id: string, rel: string, text: string, revision: string) {
    if (!editable.test(rel) || Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("文本类型或大小不受支持");
    const i = this.store.instance(id);
    const file = await safePath(i.root, rel);
    const before = await fs.readFile(file);
    if (digest(before) !== revision)
      throw new Error("文件已被其他程序修改，请重新加载后再保存");
    if (/\.json$/i.test(rel)) JSON.parse(text);
    if (path.basename(rel) === "server.properties")
      validateProperties(properties(text));
    const history = path.join(
      this.store.root,
      "config-history",
      id,
      `${Date.now()}-${path.basename(rel)}`,
    );
    await atomicWrite(history, before);
    await atomicWrite(
      file,
      (before.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
        ? "\uFEFF"
        : "") + text,
    );
    this.runtime.activity(id, `已保存配置：${rel}，旧版本已留存`);
    return this.read(id, rel);
  }
  async config(id: string) {
    const file = await this.read(id, "server.properties");
    return { ...file, values: properties(file.text) };
  }
  async saveConfig(
    id: string,
    values: Record<string, string>,
    revision: string,
  ) {
    validateProperties(values);
    const file = await this.read(id, "server.properties");
    if (file.revision !== revision) throw new Error("配置已经变更，请重新加载");
    return this.write(
      id,
      "server.properties",
      patchProperties(file.text, values),
      revision,
    );
  }
  async worlds(id: string): Promise<World[]> {
    const root = this.store.instance(id).root;
    const snap = await this.runtime.get(id);
    const folder = await safePath(root, "worlds", true);
    if (!(await exists(folder))) return [];
    const out: World[] = [];
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      const full = await safePath(root, `worlds/${item.name}`);
      const [behavior, resource, stat] = await Promise.all([
        json<any[]>(path.join(full, "world_behavior_packs.json"), []),
        json<any[]>(path.join(full, "world_resource_packs.json"), []),
        fs.stat(full),
      ]);
      out.push({
        name: item.name,
        active: item.name === snap.world,
        modified: stat.mtimeMs,
        behaviorPacks: behavior.length,
        resourcePacks: resource.length,
      });
    }
    return out.sort((a, b) => Number(b.active) - Number(a.active));
  }
  async worldSize(id: string, name: string) {
    const root = await safePath(this.store.instance(id).root, `worlds/${name}`);
    return (await walk(root)).reduce((n, f) => n + f.size, 0);
  }
  async selectWorld(id: string, name: string) {
    if ((await this.runtime.get(id)).pid)
      throw new Error("切换世界前请正常关闭服务器");
    const worlds = await this.worlds(id);
    if (!worlds.some((w) => w.name === name)) throw new Error("世界不存在");
    const config = await this.config(id);
    await this.saveConfig(id, { "level-name": name }, config.revision);
    return true;
  }
  async importWorld(id: string, source: string, name: string, ctx: JobContext) {
    if ((await this.runtime.get(id)).pid)
      throw new Error("导入世界前请正常关闭服务器");
    validateProperties({ "level-name": name });
    const root = this.store.instance(id).root;
    const target = await safePath(root, `worlds/${name}`, true);
    if (await exists(target)) throw new Error("同名世界已经存在");
    const temp = path.join(this.store.root, "work", randomUUID());
    let copying = false;
    try {
      await fs.mkdir(temp, { recursive: true });
      ctx.update(10, "展开世界文件");
      if ((await fs.stat(source)).isDirectory())
        await fs.cp(source, temp, {
          recursive: true,
          filter: async (file) => !(await fs.lstat(file)).isSymbolicLink(),
        });
      else await extractZip(source, temp, ctx.signal);
      let world = temp;
      if (!(await exists(path.join(world, "level.dat")))) {
        const candidates = (
          await fs.readdir(temp, { withFileTypes: true })
        ).filter((e) => e.isDirectory());
        if (candidates.length === 1)
          world = path.join(temp, candidates[0].name);
      }
      if (
        !(await exists(path.join(world, "level.dat"))) ||
        !(await exists(path.join(world, "db")))
      )
        throw new Error("安装包中没有有效的基岩版世界 level.dat / db");
      ctx.signal.throwIfAborted();
      await fs.mkdir(path.dirname(target), { recursive: true });
      copying = true;
      await fs.cp(world, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await atomicWrite(path.join(target, "levelname.txt"), name);
      return { name };
    } catch (error) {
      if (copying) await fs.rm(target, { recursive: true, force: true });
      throw error;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  async packs(id: string): Promise<Pack[]> {
    const i = this.store.instance(id);
    const snap = await this.runtime.get(id);
    const activeBehavior = await json<any[]>(
      path.join(i.root, "worlds", snap.world, "world_behavior_packs.json"),
      [],
    );
    const activeResource = await json<any[]>(
      path.join(i.root, "worlds", snap.world, "world_resource_packs.json"),
      [],
    );
    const out: Pack[] = [];
    for (const [folder, kind, active] of [
      ["behavior_packs", "behavior", activeBehavior],
      ["resource_packs", "resource", activeResource],
    ] as const) {
      const entries = await fs
        .readdir(path.join(i.root, folder), { withFileTypes: true })
        .catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const rel = path.join(folder, entry.name);
        const manifest = await json<any>(
          path.join(i.root, rel, "manifest.json"),
          null,
        );
        if (!manifest?.header?.uuid) continue;
        const header = manifest.header;
        let description = header.description || "";
        let name = header.name || entry.name;
        if (name.startsWith("pack.")) {
          const lang = await fs
            .readFile(path.join(i.root, rel, "texts", "zh_CN.lang"), "utf8")
            .catch(() =>
              fs
                .readFile(path.join(i.root, rel, "texts", "en_US.lang"), "utf8")
                .catch(() => ""),
            );
          const translations = properties(lang);
          name = translations[name] || entry.name;
          description = translations[description] || description;
        }
        const system = /^(vanilla|chemistry|education|editor|persona)/i.test(
          entry.name,
        );
        out.push({
          id: header.uuid,
          name,
          description,
          version: Array.isArray(header.version)
            ? header.version.join(".")
            : String(header.version),
          kind,
          path: rel,
          enabled: active.some((p) => p.pack_id === header.uuid),
          dependencies: (manifest.dependencies || [])
            .filter((d: any) => d.uuid)
            .map((d: any) => d.uuid),
          missingDependencies: [],
          system,
        });
      }
    }
    const plugins = await fs
      .readdir(path.join(i.root, "plugins"), { withFileTypes: true })
      .catch(() => []);
    for (const plugin of plugins) {
      if (
        plugin.name.startsWith(".") ||
        plugin.name === "bstats" ||
        plugin.name.endsWith(".disabled")
      )
        continue;
      const rel = path.join("plugins", plugin.name);
      out.push({
        id: `plugin:${plugin.name}`,
        name: plugin.name,
        description: "Endstone 插件 · 下次启动时加载",
        version: "本地",
        kind: "plugin",
        path: rel,
        enabled: true,
        dependencies: [],
        missingDependencies: [],
        system: false,
      });
    }
    const disabled = plugins.filter((p) => p.name.endsWith(".disabled"));
    for (const p of disabled)
      out.push({
        id: `plugin:${p.name}`,
        name: p.name.replace(/\.disabled$/, ""),
        description: "已停用的 Endstone 插件",
        version: "本地",
        kind: "plugin",
        path: path.join("plugins", p.name),
        enabled: false,
        dependencies: [],
        missingDependencies: [],
        system: false,
      });
    const ids = new Set(out.map((p) => p.id));
    for (const p of out) {
      p.missingDependencies = p.dependencies.filter((d) => !ids.has(d));
      if (p.kind !== "plugin") {
        const manifest = await json<any>(
          path.join(i.root, p.path, "manifest.json"),
          {},
        );
        for (const dependency of manifest.dependencies || []) {
          if (!dependency.uuid || !Array.isArray(dependency.version)) continue;
          const installed = out.find((item) => item.id === dependency.uuid);
          if (installed && installed.version !== dependency.version.join("."))
            p.missingDependencies.push(
              `${dependency.uuid} 需要 ${dependency.version.join(".")}，已安装 ${installed.version}`,
            );
        }
      }
    }
    return out.sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        Number(a.system) - Number(b.system) ||
        a.name.localeCompare(b.name),
    );
  }
  async togglePack(id: string, packId: string, enabled: boolean) {
    const initial = await this.runtime.get(id);
    const running = !!initial.pid;
    const pack = (await this.packs(id)).find((p) => p.id === packId);
    if (!pack) throw new Error("模组不存在");
    if (pack.system) throw new Error("原版内置包不支持在此停用");
    if (enabled && pack.missingDependencies.length)
      throw new Error("缺少依赖包，无法启用");
    if (pack.kind === "plugin" && running)
      throw new Error("插件需在服务器停止后启用或停用");
    if (enabled && running)
      throw new Error("服务器运行中不能启用内容；请停服后再启用");
    if (!enabled && !pack.enabled)
      return { disabled: [], pendingRestart: false };
    const i = this.store.instance(id);
    if (pack.kind === "plugin") {
      const from = await safePath(i.root, pack.path);
      const to = enabled ? from.replace(/\.disabled$/, "") : from + ".disabled";
      await fs.rename(from, to);
      this.runtime.activity(id, (enabled ? "启用 " : "停用 ") + pack.name);
      return { disabled: [pack.name], pendingRestart: false };
    } else {
      const snap = await this.runtime.get(id);
      if (snap.world !== initial.world)
        throw new Error("当前世界已改变，请刷新后重试");
      const worldRoot = await safePath(i.root, "worlds/" + snap.world);
      const files = new Map<
        "behavior" | "resource",
        { file: string; original: string; references: any[] }
      >();
      for (const kind of ["behavior", "resource"] as const) {
        const file = await safePath(
          worldRoot,
          "world_" + kind + "_packs.json",
          true,
        );
        let original: string;
        let references: any[];
        try {
          original = await fs.readFile(file, "utf8");
          references = JSON.parse(original.replace(/^\uFEFF/, ""));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            original = "[]";
            references = [];
          } else {
            throw new Error(
              "无法读取世界的" +
                (kind === "behavior" ? "行为包" : "资源包") +
                "引用",
            );
          }
        }
        if (!Array.isArray(references))
          throw new Error("世界模组引用格式无效，未作更改");
        files.set(kind, { file, original, references });
      }
      let disabled = [pack];
      if (enabled) {
        const current = files.get(pack.kind)!;
        if (!current.references.some((p) => p.pack_id === pack.id))
          current.references.push({
            pack_id: pack.id,
            version: pack.version.split(".").map(Number),
          });
      } else {
        const all = await this.packs(id);
        const affectedIds = new Set([pack.id]);
        let expanded = true;
        while (expanded) {
          expanded = false;
          for (const candidate of all) {
            if (
              candidate.enabled &&
              !affectedIds.has(candidate.id) &&
              candidate.dependencies.some((dependency) =>
                affectedIds.has(dependency),
              )
            ) {
              affectedIds.add(candidate.id);
              expanded = true;
            }
          }
        }
        disabled = all.filter(
          (candidate) => candidate.enabled && affectedIds.has(candidate.id),
        );
        if (!disabled.some((candidate) => candidate.id === pack.id))
          disabled.push(pack);
        for (const candidate of disabled) {
          if (candidate.kind === "plugin")
            throw new Error("依赖链包含 Endstone 插件；请停服后再停用");
          const current = files.get(candidate.kind)!;
          current.references = current.references.filter(
            (reference) => reference.pack_id !== candidate.id,
          );
        }
      }
      const current = await this.runtime.get(id);
      if (current.world !== initial.world)
        throw new Error("当前世界已改变，未修改模组引用");
      if (enabled && current.pid) throw new Error("服务器已经启动，未启用模组");
      const written: { file: string; original: string; references: any[] }[] =
        [];
      try {
        for (const [kind, state] of files) {
          const affected = disabled.some(
            (candidate) => candidate.kind === kind,
          );
          if (enabled ? kind === pack.kind : affected) {
            const next = JSON.stringify(state.references, null, 2) + "\n";
            if (next === state.original) continue;
            await atomicWrite(state.file, next);
            written.push(state);
          }
        }
      } catch (error) {
        for (const state of written.reverse())
          await atomicWrite(state.file, state.original);
        throw error;
      }
      const names = disabled.map((candidate) => candidate.name);
      this.runtime.activity(
        id,
        running
          ? "已取消模组关联，待重启生效：" + names.join("、")
          : (enabled ? "启用 " : "停用 ") + names.join("、"),
      );
      return { disabled: names, pendingRestart: running };
    }
  }
  async removePack(id: string, packId: string) {
    const pack = (await this.packs(id)).find((p) => p.id === packId);
    if (!pack || pack.system) throw new Error("不能移除此包");
    if ((await this.runtime.get(id)).pid)
      throw new Error("卸载前请正常关闭服务器");
    if (pack.enabled) await this.togglePack(id, packId, false);
    const source = await safePath(
      this.store.instance(id).root,
      pack.kind === "plugin" && pack.enabled
        ? pack.path + ".disabled"
        : pack.path,
    );
    const trash = path.join(
      this.store.root,
      "trash",
      randomUUID(),
      path.basename(source),
    );
    await fs.mkdir(path.dirname(trash), { recursive: true });
    await fs.cp(source, trash, { recursive: true });
    await fs.rm(source, { recursive: true });
    this.runtime.activity(id, `已卸载 ${pack.name}，文件保留在回收目录`);
    return true;
  }
  async installPack(
    id: string,
    source: string,
    kind: "auto" | "plugin",
    ctx: JobContext,
  ) {
    if ((await this.runtime.get(id)).pid)
      throw new Error("安装模组前请正常关闭服务器");
    const i = this.store.instance(id);
    if (kind === "plugin") {
      if (i.core !== "endstone")
        throw new Error("官方 BDS 不支持 Endstone 插件");
      if (!/\.(whl|dll|py)$/i.test(source))
        throw new Error("插件仅接受 whl、dll 或 py 文件");
      const target = await safePath(
        i.root,
        `plugins/${path.basename(source)}`,
        true,
      );
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      return { installed: [path.basename(source)] };
    }
    const temp = path.join(this.store.root, "work", randomUUID());
    const installed: string[] = [];
    try {
      ctx.update(5, "检查并展开资源包");
      await extractZip(source, temp, ctx.signal);
      let files = await walk(temp);
      for (const nested of files.filter((f) => /\.mcpack$/i.test(f.path))) {
        const dest = path.join(temp, "nested-" + randomUUID());
        await extractZip(path.join(temp, nested.path), dest, ctx.signal);
      }
      files = await walk(temp);
      const manifests = files.filter(
        (f) => path.basename(f.path) === "manifest.json",
      );
      const current = await this.packs(id);
      const candidates: {
        manifest: any;
        dir: string;
        kind: "behavior" | "resource";
      }[] = [];
      for (const file of manifests) {
        const manifest = await json<any>(path.join(temp, file.path), null);
        if (!manifest?.header?.uuid || !Array.isArray(manifest.header.version))
          continue;
        const kind = manifest.modules?.some((m: any) =>
          ["data", "script"].includes(m.type),
        )
          ? "behavior"
          : "resource";
        if (current.some((p) => p.id === manifest.header.uuid))
          throw new Error(`相同 UUID 的模组已经安装：${manifest.header.name}`);
        candidates.push({
          manifest,
          dir: path.dirname(path.join(temp, file.path)),
          kind,
        });
      }
      if (!candidates.length) throw new Error("安装包中没有可识别的资源包清单");
      for (const c of candidates) {
        ctx.signal.throwIfAborted();
        const target = await safePath(
          i.root,
          `${c.kind === "behavior" ? "behavior_packs" : "resource_packs"}/${c.manifest.header.uuid}`,
          true,
        );
        await fs.mkdir(path.dirname(target), { recursive: true });
        installed.push(target);
        await fs.cp(c.dir, target, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      return {
        installed: candidates.map((c) => c.manifest.header.name),
        note: "已安装到实例目录；请在模组页确认依赖后启用",
      };
    } catch (error) {
      for (const target of installed)
        await fs.rm(target, { recursive: true, force: true });
      throw error;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}
