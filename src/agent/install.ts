import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import net from "node:net";
import dgram from "node:dgram";
import {
  compareVersions,
  compatibleBedrock,
  windowsEndstoneVersions,
} from "./releases";
import type { Core, Instance } from "../shared/types";
import { Store } from "./store";
import { Runtime, runFile } from "./runtime";
import { Backups } from "./backups";
import { Content } from "./content";
import type { JobContext } from "./jobs";
import {
  atomicWrite,
  exists,
  extractZip,
  fileHash,
  inside,
  properties,
  patchProperties,
  validateProperties,
  json,
  safePath,
} from "./safe";

export async function assertPortsAvailable(port: number) {
  const secondary = port === 65535 ? 65534 : port + 1;
  for (const [family, target, host] of [
    [4, port, "0.0.0.0"],
    [6, secondary, "::"],
  ] as const) {
    const server = net.createServer();
    const udp = dgram.createSocket(family === 4 ? "udp4" : "udp6");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          { port: target, host, ipv6Only: true, exclusive: true },
          resolve,
        );
      });
      await new Promise<void>((resolve, reject) => {
        udp.once("error", reject);
        udp.bind({ port: target, address: host, exclusive: true }, resolve);
      });
    } catch (error: any) {
      if (!(
        family === 6 && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)
      ))
        throw new Error(
          `本机端口 ${target} 已被占用或不能绑定：${error.code || error.message}`,
        );
    } finally {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        udp.close();
      } catch {}
    }
  }
}

export async function fetchJSON(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
    headers: { "User-Agent": "ArkMC-Studio/1.0" },
  });
  if (!response.ok) throw new Error(`官方发行源返回 HTTP ${response.status}`);
  return response.json() as Promise<any>;
}
export class Installer {
  constructor(
    private store: Store,
    private runtime: Runtime,
    private backups: Backups,
    private content: Content,
    private resources: string,
  ) {}
  private toolsRoot() {
    return this.store.get(
      "managed-tools-root",
      path.join(this.store.root, "managed-tools"),
    );
  }
  async catalog() {
    const [bds, endstone] = await Promise.allSettled([
      fetchJSON(
        "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links",
      ),
      fetchJSON("https://pypi.org/pypi/endstone/json"),
    ]);
    const official =
      bds.status === "fulfilled"
        ? bds.value.result.links.find(
            (l: any) => l.downloadType === "serverBedrockWindows",
          )
        : null;
    const metadata = endstone.status === "fulfilled" ? endstone.value : null;
    return {
      bds: official
        ? {
            version:
              official.downloadUrl.match(/bedrock-server-([\d.]+)\.zip/)?.[1] ||
              "官方当前版本",
            url: official.downloadUrl,
          }
        : null,
      endstone: metadata
        ? {
            version: windowsEndstoneVersions(metadata)[0],
            latestVersion: metadata.info.version,
            versions: windowsEndstoneVersions(metadata).slice(0, 15),
          }
        : null,
      errors: [
        bds.status === "rejected" ? "BDS 官方目录暂不可用" : "",
        endstone.status === "rejected" ? "Endstone 官方目录暂不可用" : "",
      ].filter(Boolean),
      eula: "https://www.minecraft.net/eula",
    };
  }
  private async download(
    url: string,
    target: string,
    ctx: JobContext,
    expected?: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      ![
        "www.minecraft.net",
        "minecraft.azureedge.net",
        "raw.githubusercontent.com",
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "pypi.org",
        "files.pythonhosted.org",
      ].includes(parsed.hostname)
    )
      throw new Error("下载地址不是受支持的官方发行源");
    const response = await fetch(url, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300000)]),
      redirect: "follow",
    });
    if (!response.ok || !response.body)
      throw new Error(`下载失败 HTTP ${response.status}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    let last = 0;
    const hash = createHash("sha256");
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        hash.update(chunk);
        if (Date.now() - last > 350) {
          ctx.update(
            total ? 10 + Math.min(40, Math.round((received / total) * 40)) : 25,
            `下载 ${(received / 1024 ** 2).toFixed(1)} MB${total ? " / " + (total / 1024 ** 2).toFixed(1) + " MB" : ""}`,
          );
          last = Date.now();
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as any),
        meter,
        createWriteStream(target, { flags: "wx" }),
        { signal: ctx.signal },
      );
      const actual = hash.digest("hex");
      if (expected && actual !== expected)
        throw new Error("官方 SHA-256 校验失败");
      return actual;
    } catch (error) {
      await fs.rm(target, { force: true });
      throw error;
    }
  }
  private async prepare(
    core: Core,
    version: string | undefined,
    zip: string | undefined,
    stage: string,
    ctx: JobContext,
  ) {
    await fs.mkdir(stage, { recursive: true });
    const receipt: any = { core, at: Date.now() };
    if (core === "bds") {
      let source = zip;
      if (!source) {
        const catalog = await this.catalog();
        if (!catalog.bds)
          throw new Error("无法读取官方版本，请导入官方 Windows ZIP");
        if (version && catalog.bds.version !== version)
          throw new Error("官方 BDS 版本已变化，请重新检查更新后再操作");
        source = path.join(
          this.toolsRoot(),
          "downloads",
          randomUUID() + ".zip",
        );
        receipt.url = catalog.bds.url;
        receipt.version = catalog.bds.version;
        receipt.sha256 = await this.download(catalog.bds.url, source, ctx);
      } else {
        if (!/\.zip$/i.test(source)) throw new Error("请选择官方 Windows ZIP");
        receipt.sha256 = await fileHash(source);
      }
      ctx.update(55, "检查并展开官方服务端");
      await extractZip(source, stage, ctx.signal);
      if (
        !(await exists(path.join(stage, "bedrock_server.exe"))) ||
        !(await exists(path.join(stage, "server.properties")))
      )
        throw new Error("安装包不是有效的 Windows BDS 服务端");
      if (receipt.version)
        await atomicWrite(path.join(stage, "version.txt"), receipt.version);
    } else {
      const toolsRoot = this.store.get(
        "managed-tools-root",
        path.join(this.store.root, "managed-tools"),
      );
      const uvReceipt = await json<{ executable: string } | null>(
        path.join(toolsRoot, "bin", "uv", "current.json"),
        null,
      );
      const uv = uvReceipt
        ? await safePath(toolsRoot, uvReceipt.executable)
        : path.join(this.resources, "runtime", "uv.exe");
      if (!(await exists(uv)))
        throw new Error("安装运行时尚未打包，请执行 prepare:resources");
      const env = {
        ...process.env,
        UV_PYTHON_INSTALL_DIR: path.join(toolsRoot, "runtimes", "python"),
        UV_CACHE_DIR: path.join(toolsRoot, "cache", "uv"),
        UV_NO_PROGRESS: "1",
      };
      ctx.update(8, "准备独立 Python 3.13 运行环境");
      await runFile(uv, ["python", "install", "3.13"], {
        env,
        timeout: 300000,
      });
      const python = (
        await runFile(uv, ["python", "find", "--managed-python", "3.13"], {
          env,
        })
      ).trim();
      const environment = path.join(
        toolsRoot,
        "runtimes",
        "endstone",
        path.basename(stage),
      );
      await runFile(
        uv,
        ["venv", "--relocatable", "--python", python, environment],
        { env },
      );
      const venv = path.join(environment, "Scripts", "python.exe");
      receipt.python = venv;
      const selected = version || (await this.catalog()).endstone?.version;
      if (!selected || !/^\d+\.\d+\.\d+$/.test(selected))
        throw new Error("请选择有效的 Endstone 正式版本");
      ctx.update(18, `安装 Endstone ${selected}`);
      await runFile(
        uv,
        ["pip", "install", "--python", venv, `endstone==${selected}`],
        { env, timeout: 300000 },
      );
      const compatible = (
        await runFile(venv, [
          "-c",
          "from endstone import __minecraft_version__; print(str(__minecraft_version__))",
        ])
      ).trim();
      const binary = await compatibleBedrock(compatible, ctx.signal);
      const archive = path.join(
        this.toolsRoot(),
        "downloads",
        randomUUID() + ".zip",
      );
      receipt.url = binary.url;
      receipt.sha256 = await this.download(
        binary.url,
        archive,
        ctx,
        binary.sha256,
      );
      await extractZip(archive, stage, ctx.signal);
      await atomicWrite(path.join(stage, "version.txt"), binary.version);
      receipt.version = binary.version;
      receipt.endstoneVersion = selected;
    }
    await atomicWrite(
      path.join(stage, ".ark-install.json"),
      JSON.stringify(receipt, null, 2),
    );
    return receipt;
  }
  async create(
    options: {
      name: string;
      root: string;
      core: Core;
      version?: string;
      zip?: string;
      port: number;
      accepted: boolean;
    },
    ctx: JobContext,
  ) {
    if (!options.accepted) throw new Error("请先阅读并接受 Minecraft EULA");
    validateProperties({
      "server-name": options.name,
      "level-name": options.name,
      "server-port": String(options.port),
    });
    const root = path.resolve(options.root);
    const toolsRoot = this.store.get(
      "managed-tools-root",
      path.join(this.store.root, "managed-tools"),
    );
    if (inside(root, toolsRoot) || inside(toolsRoot, root))
      throw new Error("核心实例与工具目录不能嵌套");
    if (!path.isAbsolute(options.root)) throw new Error("请选择完整的实例目录");
    for (const i of this.store.instances()) {
      if (inside(i.root, root) || inside(root, i.root))
        throw new Error("新实例目录不能与已有实例重叠");
      const config = (await this.content.config(i.id)).values;
      const used = [
        Number(config["server-port"] || 19132),
        Number(config["server-portv6"] || 19133),
      ];
      if (
        used.includes(options.port) ||
        used.includes(options.port === 65535 ? 65534 : options.port + 1)
      )
        throw new Error("该端口已经被另一个实例配置使用");
    }
    if ((await exists(root)) && (await fs.readdir(root)).length)
      throw new Error("新实例必须使用空目录");
    await assertPortsAvailable(options.port);
    const stage = path.join(
      this.toolsRoot(),
      ".staging",
      `install-${randomUUID()}`,
    );
    const candidate = path.join(
      path.dirname(root),
      `.ark-install-${randomUUID()}`,
    );
    let committed = false;
    try {
      const receipt = await this.prepare(
        options.core,
        options.version,
        options.zip,
        stage,
        ctx,
      );
      ctx.signal.throwIfAborted();
      const config = await fs.readFile(
        path.join(stage, "server.properties"),
        "utf8",
      );
      await atomicWrite(
        path.join(stage, "server.properties"),
        patchProperties(config, {
          "server-name": options.name,
          "level-name": options.name,
          "server-port": String(options.port),
          "server-portv6": String(
            options.port === 65535 ? 65534 : options.port + 1,
          ),
          "enable-lan-visibility": "false",
        }),
      );
      ctx.update(85, "写入独立实例目录");
      await fs.mkdir(path.dirname(root), { recursive: true });
      await fs.cp(stage, candidate, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      ctx.signal.throwIfAborted();
      if (await exists(root)) await fs.rmdir(root);
      await fs.rename(candidate, root);
      committed = true;
      const instance = await this.runtime.import(root);
      instance.adapter = "managed";
      instance.core = options.core;
      instance.python =
        options.core === "endstone" ? receipt.python : undefined;
      instance.version = receipt.version;
      await this.runtime.saveInstance(instance);
      return instance;
    } catch (error) {
      if (committed && !this.store.instances().some((i) => i.root === root))
        await fs.rm(root, { recursive: true, force: true });
      throw error;
    } finally {
      await fs.rm(candidate, { recursive: true, force: true });
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  async update(
    id: string,
    version: string | undefined,
    zip: string | undefined,
    ctx: JobContext,
    requestedCore?: Core,
    beforeCommit?: (receipt: any) => Promise<void>,
  ) {
    const i = this.store.instance(id);
    const previousInstance = { ...i };
    const targetCore = requestedCore ?? i.core;
    const stage = path.join(
      this.toolsRoot(),
      ".staging",
      `update-${randomUUID()}`,
    );
    const before = await this.runtime.get(id);
    const running = !!before.pid;
    let receipt: any;
    let committed = false;
    let backupId: string | undefined;
    try {
      ctx.update(2, "在临时目录准备兼容的新核心");
      receipt = await this.prepare(targetCore, version, zip, stage, ctx);
      if (targetCore === "endstone" && previousInstance.core === "bds") {
        const currentVersion = previousInstance.version || before.version;
        const difference = compareVersions(receipt.version, currentVersion);
        if (difference == null)
          throw new Error(
            "无法确认当前 BDS 版本，拒绝切换到可能降级的 Endstone",
          );
        if (difference < 0)
          throw new Error(
            `Endstone 仅兼容 BDS ${receipt.version}，低于当前 ${currentVersion}；拒绝降级世界核心`,
          );
      }
      ctx.signal.throwIfAborted();
      if (beforeCommit) await beforeCommit(receipt);
      if (running) await this.runtime.stop(id);
      ctx.update(60, "创建更新前完整快照");
      const backup = await this.backups.create(id, "full", {
        ...ctx,
        update: (p, d) => ctx.update(60 + p * 0.15, d),
      });
      backupId = backup.id;
      ctx.signal.throwIfAborted();
      ctx.update(78, "切换核心，保留地图、配置与自定义资源");
      const preserve = new Set([
        "server.properties",
        "allowlist.json",
        "permissions.json",
        "worlds",
        "plugins",
        "logs",
        "tunnel-endpoint.json",
        "run-server.py",
        "Start-Server.ps1",
        "Server-Command.ps1",
      ]);
      for (const entry of await fs.readdir(stage, { withFileTypes: true })) {
        if (preserve.has(entry.name)) continue;
        const dest = path.join(i.root, entry.name);
        if (entry.name === ".venv" && (await exists(dest)))
          await fs.rm(dest, { recursive: true, force: true });
        await fs.cp(path.join(stage, entry.name), dest, {
          recursive: true,
          force: true,
        });
      }
      i.core = targetCore;
      i.version = receipt.version;
      if (targetCore === "endstone") {
        i.python = receipt.python;
        i.preferredCore = "endstone";
      } else {
        i.python = previousInstance.python;
        i.preferredCore =
          previousInstance.preferredCore ?? previousInstance.core;
      }
      await this.runtime.saveInstance(i);
      if (running) await this.runtime.start(id);
      committed = true;
      return {
        version: receipt.version,
        endstoneVersion: receipt.endstoneVersion,
        core: targetCore,
        previousCore: previousInstance.core,
        rollbackBackup: backupId,
      };
    } catch (error) {
      if (backupId) {
        ctx.update(90, "更新失败，恢复更新前快照");
        await this.backups
          .restore(backupId, {
            ...ctx,
            signal: new AbortController().signal,
            update: (p, d) => ctx.update(90 + p * 0.1, d),
          })
          .catch((rollback) => {
            throw new Error(
              `更新失败，回退也未完成：${rollback.message}；恢复点 ${backupId}`,
            );
          });
        await this.runtime.saveInstance(previousInstance);
      }
      if (running && !(await this.runtime.get(id)).pid)
        await this.runtime.start(id).catch(() => {});
      throw error;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
      if (!committed && targetCore === "endstone") {
        const environment = path.join(
          this.toolsRoot(),
          "runtimes",
          "endstone",
          path.basename(stage),
        );
        await fs.rm(environment, { recursive: true, force: true });
      }
    }
  }
}
