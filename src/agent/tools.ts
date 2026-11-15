import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse, stringify } from "smol-toml";
import type { ToolId, ToolInfo } from "../shared/types";
import { Store } from "./store";
import { Runtime, runFile } from "./runtime";
import type { JobContext } from "./jobs";
import {
  atomicWrite,
  availableBytes,
  exists,
  extractZip,
  fileHash,
  inside,
  json,
  safePath,
  sleep,
} from "./safe";

const catalog = {
  lolia: {
    name: "LoliaFRP 客户端",
    repo: "Lolia-FRP/lolia-frp",
    asset: /LoliaFrp_windows_amd64\.zip$/i,
    binary: "frpc.exe",
    args: ["--version"],
  },
  sakura: {
    name: "SakuraFrp · 樱花客户端",
    repo: "natfrp/frp",
    asset: /^frpc_windows_amd64\.exe$/,
    binary: "frpc.exe",
    args: ["--version"],
  },
  frp: {
    name: "官方 FRP 客户端",
    repo: "fatedier/frp",
    asset: /frp_[\d.]+_windows_amd64\.zip$/i,
    binary: "frpc.exe",
    args: ["--version"],
  },
  uv: {
    name: "uv · Python 环境管理",
    repo: "astral-sh/uv",
    asset: /^uv-x86_64-pc-windows-msvc\.zip$/,
    binary: "uv.exe",
    args: ["--version"],
  },
} as const;
type Receipt = {
  version: string;
  executable: string;
  sha256?: string;
  installedAt: number;
  source: string;
};

export async function latestTool(tool: ToolId, signal?: AbortSignal) {
  const spec = catalog[tool];
  if (tool === "sakura") {
    const response = await fetch(
      "https://api.natfrp.com/v4/system/clients?download=true",
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
          : AbortSignal.timeout(25000),
        headers: { "User-Agent": "ArkMC-Studio" },
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new Error(`樱花官方版本查询失败 HTTP ${response.status}`);
    const data = (await response.json()) as any;
    const asset = data.frpc?.archs?.windows_amd64;
    const version = String(data.frpc?.ver || "");
    if (!asset || !/^\d+\.\d+\.\d+-sakura-[\w.-]+$/.test(version))
      throw new Error("樱花官方未提供 Windows x64 稳定客户端");
    const url = new URL(asset.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "nya.globalslb.net" ||
      url.pathname !==
        `/natfrp/client/frpc/${version}/frpc_windows_amd64.exe` ||
      !/^[a-f0-9]{32}$/i.test(String(asset.hash))
    )
      throw new Error("樱花官方发行包来源或校验记录无效");
    return {
      version,
      sha256: "",
      checksum: String(asset.hash).toLowerCase(),
      algorithm: "md5" as const,
      format: "exe" as const,
      url: url.href,
      size: Number(asset.size),
    };
  }
  const response = await fetch(
    `https://api.github.com/repos/${spec.repo}/releases/latest`,
    {
      headers: {
        "User-Agent": "ArkMC-Studio",
        Accept: "application/vnd.github+json",
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
        : AbortSignal.timeout(25000),
    },
  );
  if (!response.ok) throw new Error(`官方版本查询失败 HTTP ${response.status}`);
  const data = (await response.json()) as any;
  const asset = data.assets?.find((a: any) => spec.asset.test(a.name));
  const version = String(data.tag_name || "").replace(/^v/, "");
  if (!asset || !/^\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(version))
    throw new Error("官方发行包不支持 Windows x64");
  const sha256 = String(asset.digest || "").replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/i.test(sha256))
    throw new Error("官方发行源没有提供可验证的 SHA-256，已保留现用版本");
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(`/${spec.repo}/releases/download/`)
  )
    throw new Error("发行包来源校验失败");
  return {
    version,
    sha256: sha256.toLowerCase(),
    checksum: sha256.toLowerCase(),
    algorithm: "sha256" as const,
    format: "zip" as const,
    url: url.href,
    size: Number(asset.size),
  };
}

async function findBinary(root: string, name: string): Promise<string> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("工具目录不允许使用链接");
    if (entry.isFile() && entry.name.toLowerCase() === name)
      return path.join(root, entry.name);
  }
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = await findBinary(path.join(root, entry.name), name).catch(
        () => "",
      );
      if (found) return found;
    }
  }
  throw new Error(`安装包中没有 ${name}`);
}

export class Tools {
  readonly root: string;
  private releases = new Map<ToolId, Awaited<ReturnType<typeof latestTool>>>();
  constructor(
    private store: Store,
    private runtime: Runtime,
    private resources: string,
    root?: string,
  ) {
    this.root = path.resolve(
      store.get(
        "managed-tools-root",
        root || path.join(store.root, "managed-tools"),
      ),
    );
    this.store.set("managed-tools-root", this.root);
  }
  async assertRoot() {
    for (const i of this.store.instances()) {
      let core = i.root;
      const expectedLink = path.join(this.root, "server-links", i.id);
      if (path.resolve(core).toLowerCase() === expectedLink.toLowerCase()) {
        const stat = await fs.lstat(core).catch(() => null);
        if (stat?.isSymbolicLink()) core = await fs.realpath(core);
      }
      if (inside(core, this.root) || inside(this.root, core))
        throw new Error("工具目录与核心实例目录必须独立存放");
    }
    await fs.mkdir(this.root, { recursive: true });
    const actual = await fs.realpath(this.root);
    if (actual.toLowerCase() !== this.root.toLowerCase())
      throw new Error("工具根目录不能通过链接重定向");
  }
  private receipt(tool: ToolId) {
    return path.join(this.root, "bin", tool, "current.json");
  }
  async list(check = false) {
    await this.assertRoot();
    const items = await Promise.all(
      (Object.keys(catalog) as ToolId[]).map(
        async (tool): Promise<ToolInfo> => {
          const spec = catalog[tool];
          const installed = await json<Receipt | null>(
            this.receipt(tool),
            null,
          );
          let executable = installed
            ? await safePath(this.root, installed.executable, true)
            : undefined;
          let version =
            executable && (await exists(executable))
              ? installed!.version
              : undefined;
          if (
            !version &&
            tool === "uv" &&
            (await exists(path.join(this.resources, "runtime", "uv.exe")))
          ) {
            executable = path.join(this.resources, "runtime", "uv.exe");
            version = (await runFile(executable, ["--version"])).match(
              /\d+\.\d+\.\d+/,
            )?.[0];
          }
          let error: string | undefined;
          if (check) {
            try {
              this.releases.set(tool, await latestTool(tool));
            } catch (e: any) {
              error = e.message;
            }
          }
          const latest = this.releases.get(tool);
          return {
            tool,
            name: spec.name,
            installedVersion: version,
            latestVersion: latest?.version,
            executable,
            source:
              tool === "sakura"
                ? "https://www.natfrp.com/tunnel/download"
                : `https://github.com/${spec.repo}`,
            updateAvailable:
              !!version && !!latest && version !== latest.version,
            error,
            bundled: tool === "uv" && !installed,
          };
        },
      ),
    );
    return {
      root: this.root,
      items,
      environments: this.store
        .instances()
        .filter((i) => i.python)
        .map((i) => ({
          id: i.id,
          name: i.name,
          python: i.python!,
          managed: inside(this.root, i.python!),
        })),
      instances: this.store.instances().map((i) => ({
        id: i.id,
        name: i.name,
        root: i.root,
        tunnelRoot: i.tunnelRoot,
        managed:
          (!i.python || inside(this.root, i.python)) &&
          (!i.tunnelRoot || inside(this.root, i.tunnelRoot)) &&
          i.adapter === "managed",
      })),
    };
  }
  async install(tool: ToolId, ctx: JobContext) {
    await this.assertRoot();
    ctx.update(2, "查询官方稳定发行版本");
    const release = await latestTool(tool, ctx.signal);
    this.releases.set(tool, release);
    const area = path.join(this.root, ".staging", randomUUID());
    const archive = path.join(area, "download.zip");
    const unpacked = path.join(area, "unpacked");
    await fs.mkdir(area, { recursive: true });
    try {
      if (
        !Number.isFinite(release.size) ||
        release.size <= 0 ||
        release.size > 256 * 1024 ** 2 ||
        (await availableBytes(area)) < release.size * 4 + 128 * 1024 ** 2
      )
        throw new Error("安装包过大或磁盘空间不足");
      const response = await fetch(release.url, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300000)]),
      });
      if (!response.ok || !response.body)
        throw new Error(`工具下载失败 HTTP ${response.status}`);
      let size = 0,
        last = 0;
      const meter = new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          if (size > release.size)
            return done(new Error("发行包长度超出官方记录"));
          if (Date.now() - last > 400) {
            ctx.update(
              5 + (size / release.size) * 50,
              `下载 ${(size / 1024 ** 2).toFixed(1)} / ${(release.size / 1024 ** 2).toFixed(1)} MB`,
            );
            last = Date.now();
          }
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as any),
        meter,
        createWriteStream(archive, { flags: "wx" }),
        { signal: ctx.signal },
      );
      const officialHash = createHash(release.algorithm);
      for await (const chunk of createReadStream(archive))
        officialHash.update(chunk);
      if (
        size !== release.size ||
        officialHash.digest("hex") !== release.checksum
      )
        throw new Error(
          `官方安装包长度或 ${release.algorithm.toUpperCase()} 校验失败；没有切换现用版本`,
        );
      const localSha256 = await fileHash(archive);
      ctx.update(60, "官方校验通过，准备独立版本目录");
      if (release.format === "exe") {
        await fs.mkdir(unpacked, { recursive: true });
        await fs.copyFile(archive, path.join(unpacked, catalog[tool].binary));
      } else await extractZip(archive, unpacked, ctx.signal, 512 * 1024 ** 2);
      const binary = await findBinary(unpacked, catalog[tool].binary);
      const output = await runFile(binary, [...catalog[tool].args], {
        timeout: 15000,
      });
      if (!output.includes(release.version))
        throw new Error("客户端自报版本与发行记录不符");
      ctx.signal.throwIfAborted();
      const destination = path.join(
        this.root,
        "bin",
        tool,
        `${release.version}-${randomUUID().slice(0, 8)}`,
      );
      await fs.mkdir(path.dirname(destination), { recursive: true });
      for (let n = 0; ; n++) {
        try {
          await fs.rename(unpacked, destination);
          break;
        } catch (error: any) {
          if (n >= 12 || !["EBUSY", "EPERM", "EACCES"].includes(error.code))
            throw error;
          await sleep(250, ctx.signal);
        }
      }
      const executable = path.join(
        destination,
        path.relative(unpacked, binary),
      );
      const previous = await json<Receipt | null>(this.receipt(tool), null);
      if (previous)
        await atomicWrite(
          path.join(path.dirname(this.receipt(tool)), "previous.json"),
          JSON.stringify(previous, null, 2),
        );
      await atomicWrite(
        this.receipt(tool),
        JSON.stringify(
          {
            version: release.version,
            executable: path.relative(this.root, executable),
            sha256: localSha256,
            installedAt: Date.now(),
            source: release.url,
          } satisfies Receipt,
          null,
          2,
        ),
      );
      ctx.update(
        100,
        "工具已就绪；运行中的隧道在下次启动或重新加载时使用新版本",
      );
      return {
        tool,
        version: release.version,
        executable,
        runningProcessesUnchanged: true,
      };
    } finally {
      await fs
        .rm(area, {
          recursive: true,
          force: true,
          maxRetries: 12,
          retryDelay: 250,
        })
        .catch(() => {});
    }
  }
  async prepareNetwork(id: string) {
    await this.assertRoot();
    const i = this.store.instance(id);
    if (!i.tunnelRoot) {
      i.tunnelRoot = path.join(this.root, "network", id);
      await fs.mkdir(path.join(i.tunnelRoot, "private"), { recursive: true });
      await atomicWrite(path.join(i.tunnelRoot, "tunnel-summary.json"), "[]");
      this.store.put("instances", i);
    }
    if (!inside(this.root, i.tunnelRoot))
      throw new Error("请先在工具中心迁移已有隧道目录");
    return i.tunnelRoot;
  }
  async prepareRouterRuntime(ctx: JobContext) {
    await this.assertRoot();
    const installed = await json<Receipt | null>(this.receipt("uv"), null);
    const uv = installed
      ? await safePath(this.root, installed.executable)
      : path.join(this.resources, "runtime", "uv.exe");
    if (!(await exists(uv))) throw new Error("请先一键下载 uv 工具");
    const env = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: path.join(this.root, "runtimes", "python"),
      UV_CACHE_DIR: path.join(this.root, "cache", "uv"),
      UV_NO_PROGRESS: "1",
    };
    ctx.update(10, "准备通用信令转接层的独立 Python 3.13");
    await runFile(uv, ["python", "install", "3.13"], { env, timeout: 300000 });
    ctx.signal.throwIfAborted();
    const python = (
      await runFile(uv, ["python", "find", "--managed-python", "3.13"], { env })
    ).trim();
    const directory = path.join(
      this.root,
      "runtimes",
      "signal-router",
      randomUUID(),
    );
    await runFile(
      uv,
      ["venv", "--relocatable", "--python", python, directory],
      { env },
    );
    const executable = path.join(directory, "Scripts", "python.exe");
    try {
      ctx.update(50, "从 PyPI 安装信令转接层依赖");
      await runFile(
        uv,
        ["pip", "install", "--python", executable, "aiohttp>=3.12,<4"],
        { env, timeout: 300000 },
      );
      ctx.signal.throwIfAborted();
      const version = (
        await runFile(executable, [
          "-c",
          "import aiohttp;print(aiohttp.__version__)",
        ])
      ).trim();
      await atomicWrite(
        path.join(this.root, "runtimes", "signal-router", "current.json"),
        JSON.stringify(
          { python: executable, version, at: Date.now() },
          null,
          2,
        ),
      );
      return { python: executable, aiohttp: version };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async organize(id: string, source: string | undefined, ctx: JobContext) {
    await this.assertRoot();
    const i = this.store.instance(id);
    if (!this.runtime.samplerReady) throw new Error("正在识别进程，请稍后重试");
    if ((await this.runtime.get(id)).pid)
      throw new Error("请先正常关闭该实例，再整理工具目录");
    const tunnelSource = source || i.tunnelRoot;
    const moving = [
      tunnelSource,
      i.python ? path.dirname(path.dirname(i.python)) : undefined,
    ].filter(Boolean) as string[];
    if (
      this.runtime.processes.some((p) =>
        moving.some(
          (root) =>
            inside(root, p.path || "") ||
            p.command?.toLowerCase().includes(root.toLowerCase()),
        ),
      )
    )
      throw new Error("请先停止关联隧道和转接层，再迁移工具");
    const original = { ...i };
    const moved: { from: string; to: string }[] = [];
    const rewritten: { file: string; content: string | Buffer }[] = [];
    const move = async (from: string, to: string) => {
      if (!(await exists(from))) return;
      if (await exists(to)) throw new Error(`目标已存在：${to}`);
      if ((await fs.lstat(from)).isSymbolicLink())
        throw new Error("迁移源不能是链接");
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      moved.push({ from, to });
    };
    try {
      ctx.update(15, "迁移独立核心运行环境");
      if (i.python && inside(i.root, i.python)) {
        const oldEnvironment = path.dirname(path.dirname(i.python));
        const environment = path.join(this.root, "runtimes", "endstone", id);
        const cfg = await fs.readFile(
          path.join(oldEnvironment, "pyvenv.cfg"),
          "utf8",
        );
        const home = cfg.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
        if (!home || !(await exists(path.join(home, "python.exe"))))
          throw new Error("无法识别现有 Python 基础运行时");
        const actualHome = await fs.realpath(home);
        const pythonHome = path.join(
          this.root,
          "runtimes",
          "python",
          path.basename(actualHome),
        );
        if (!(await exists(pythonHome)))
          await fs.cp(actualHome, pythonHome, {
            recursive: true,
            errorOnExist: true,
            force: false,
            dereference: true,
          });
        await move(oldEnvironment, environment);
        const cfgFile = path.join(environment, "pyvenv.cfg");
        rewritten.push({ file: cfgFile, content: cfg });
        await atomicWrite(
          cfgFile,
          cfg.replace(/^home\s*=.*$/m, `home = ${pythonHome}`),
        );
        // uv's Windows launcher embeds its original base interpreter path.
        // Regenerate CPython's launchers; changing pyvenv.cfg alone is insufficient.
        const launcherStage = path.join(
          this.root,
          ".staging",
          `venv-${randomUUID()}`,
        );
        try {
          await runFile(path.join(pythonHome, "python.exe"), [
            "-m",
            "venv",
            "--without-pip",
            launcherStage,
          ]);
          for (const name of ["python.exe", "pythonw.exe"]) {
            const target = path.join(environment, "Scripts", name);
            rewritten.push({
              file: target,
              content: await fs.readFile(target),
            });
            await atomicWrite(
              target,
              await fs.readFile(path.join(launcherStage, "Scripts", name)),
            );
          }
        } finally {
          await fs
            .rm(launcherStage, { recursive: true, force: true })
            .catch(() => {});
        }
        i.python = path.join(environment, "Scripts", "python.exe");
        const check = JSON.parse(
          await runFile(i.python, [
            "-c",
            "import sys, endstone, aiohttp, json; print(json.dumps({'base':sys._base_executable,'prefix':sys.prefix,'version':endstone.__version__}))",
          ]),
        );
        if (
          !inside(pythonHome, check.base) ||
          path.resolve(check.prefix) !== path.resolve(environment)
        )
          throw new Error("迁移后的 Python 仍引用旧目录，已回退迁移");
      }
      ctx.update(45, "迁移线路配置、证书和客户端");
      if (tunnelSource && !inside(this.root, tunnelSource)) {
        const real = await fs.realpath(tunnelSource);
        if (
          (await exists(path.join(real, "server.properties"))) ||
          inside(real, this.root)
        )
          throw new Error("请选择专用隧道目录，不能移动服务端或管理程序根目录");
        const destination = path.join(this.root, "network", id);
        await move(real, destination);
        i.tunnelRoot = destination;
        const privateRoot = path.join(destination, "private");
        for (const entry of await fs.readdir(privateRoot, {
          withFileTypes: true,
        })) {
          if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
          const file = path.join(privateRoot, entry.name),
            content = await fs.readFile(file, "utf8");
          rewritten.push({ file, content });
          const document = parse(content) as any;
          for (const proxy of document.proxies || [])
            if (proxy.plugin?.autoTLS)
              proxy.plugin.autoTLS.cacheDir = path.join(
                privateRoot,
                ".autotls-cache",
              );
          await atomicWrite(file, stringify(document));
        }
        if (!(await exists(this.receipt("lolia")))) {
          const binary = await findBinary(destination, "frpc.exe");
          const version =
            (await runFile(binary, ["--version"])).match(
              /\d+\.\d+\.\d+/,
            )?.[0] || "已导入";
          await atomicWrite(
            this.receipt("lolia"),
            JSON.stringify(
              {
                version,
                executable: path.relative(this.root, binary),
                installedAt: Date.now(),
                source: "existing-local-client",
              } satisfies Receipt,
              null,
              2,
            ),
          );
        }
      }
      if (
        i.tunnelRoot &&
        (await exists(
          path.join(i.tunnelRoot, "signal-router", "Start-Router.ps1"),
        ))
      ) {
        const file = path.join(
          i.tunnelRoot,
          "signal-router",
          "Start-Router.ps1",
        );
        const content = await fs.readFile(file, "utf8");
        rewritten.push({ file, content });
        await atomicWrite(
          file,
          content.replace(
            /^\$python=.*$/m,
            "$python=(Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime.json') -Raw | ConvertFrom-Json).python",
          ),
        );
        await atomicWrite(
          path.join(i.tunnelRoot, "runtime.json"),
          JSON.stringify({ python: i.python }, null, 2),
        );
        const config = await json<any>(
          path.join(i.tunnelRoot, "signal-router", "router.json"),
          null,
        );
        if (
          config &&
          !(await exists(path.join(i.tunnelRoot, "signal-routers.json")))
        ) {
          const summaries = await json<any[]>(
            path.join(i.tunnelRoot, "tunnel-summary.json"),
            [],
          );
          const signal = summaries.find((s) =>
            s.proxies?.some((p: any) =>
              p.pluginLocalAddr?.endsWith(`:${config.listenPort}`),
            ),
          );
          const udp = summaries.find(
            (s) =>
              s.node === signal?.node &&
              s.proxies?.some((p: any) => p.type === "udp"),
          );
          if (!signal || !udp)
            throw new Error("未能确定原转接层关联的信令和 UDP 隧道");
          await atomicWrite(
            path.join(i.tunnelRoot, "signal-routers.json"),
            JSON.stringify(
              [
                {
                  key: `route-${signal.id}`,
                  name: signal.node || config.routeName,
                  signalId: signal.id,
                  udpId: udp.id,
                  enabled: true,
                  ...config,
                },
              ].map(({ routeName: _legacyName, ...item }) => item),
              null,
              2,
            ),
          );
        }
      }
      const control = path.join(this.root, "instances", id);
      if (
        i.tunnelRoot &&
        (await exists(path.join(i.tunnelRoot, "signal-routers.json")))
      ) {
        await move(
          path.join(i.tunnelRoot, "signal-router"),
          path.join(control, "legacy-network", "signal-router"),
        );
        for (const name of [
          "Start-Tunnels.ps1",
          "inspect-tunnels.py",
          "启动Lolia隧道.cmd",
          "runtime.json",
        ])
          await move(
            path.join(i.tunnelRoot, name),
            path.join(control, "legacy-network", name),
          );
      }
      for (const name of [
        "run-server.py",
        "Start-Server.ps1",
        "Server-Command.ps1",
        "启动MC服务器.cmd",
        "启动MC和Lolia.cmd",
        "正常关闭MC服务器.cmd",
        "运行说明.md",
        ".server-lock",
        ".server-state.json",
        ".console-command.json",
        "cloud-return-receipt.json",
        "connection-check-receipt.json",
        "__pycache__",
      ]) {
        await move(path.join(i.root, name), path.join(control, "legacy", name));
      }
      if (await exists(path.join(i.root, "tunnel-endpoint.json"))) {
        i.endpointPath = path.join(control, "tunnel-endpoint.json");
        await move(path.join(i.root, "tunnel-endpoint.json"), i.endpointPath);
      }
      for (const entry of await fs.readdir(i.root, { withFileTypes: true })) {
        if (entry.isFile() && /^endstone-.+\.whl$/i.test(entry.name))
          await move(
            path.join(i.root, entry.name),
            path.join(this.root, "downloads", "endstone", entry.name),
          );
      }
      i.adapter = "managed";
      await atomicWrite(
        path.join(control, "instance.json"),
        JSON.stringify(i, null, 2),
      );
      this.store.put("instances", i);
      this.runtime.activity(id, "第三方工具与启动控制已归入管理程序目录");
      return {
        python: i.python,
        tunnelRoot: i.tunnelRoot,
        control,
        moved: moved.length,
      };
    } catch (error) {
      for (const item of rewritten.reverse())
        await atomicWrite(item.file, item.content).catch(() => {});
      for (const item of moved.reverse())
        await fs.rename(item.to, item.from).catch(() => {});
      this.store.put("instances", original);
      throw error;
    }
  }
}
