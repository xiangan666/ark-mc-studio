import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import tls from "node:tls";
import { isIPv4 } from "node:net";
import { spawn } from "node:child_process";
import { parse, stringify } from "smol-toml";
import type {
  Diagnostic,
  Route,
  Tunnel,
  SignalRouterConfig,
  RouteQualityReport,
  RouteQuality,
} from "../shared/types";
import { Store } from "./store";
import { Runtime, ps, runFile } from "./runtime";
import { measureRouteQuality, recommendRoute } from "./route-quality";
import { resolveTunnelClient } from "./tunnel-clients";
import {
  routerConfigError,
  uniqueTunnelClients,
  type TunnelProvider,
} from "../shared/network";
import type { JobContext } from "./jobs";
import {
  atomicWrite,
  errorText,
  exists,
  json,
  redact,
  safePath,
  sleep,
} from "./safe";
import {
  applySakuraOverrides,
  parseSakuraIni,
  sakuraRequest,
  sakuraSummary,
  writeSakuraIni,
} from "./sakura";

export const isSignalTunnel = (t: Pick<Tunnel, "type" | "autoTLS">) =>
  ["http", "https"].includes(t.type) || (t.type === "tcp" && !!t.autoTLS);
export function tunnelConfigPath(
  root: string,
  tunnel: Pick<Tunnel, "id" | "provider">,
) {
  return path.join(
    root,
    "private",
    `tunnel-${tunnel.id}.${tunnel.provider === "sakura" ? "ini" : "toml"}`,
  );
}
export async function resolveUdpIPv4(host: string) {
  return isIPv4(host) ? host : (await dns.resolve4(host))[0];
}

type UdpBindingEvidence = {
  targetIP: string;
  targetPort: number;
  transport: string;
  addresses?: string[];
};

export function assessUdpBinding(
  evidence: UdpBindingEvidence,
  transportVerified = false,
): Pick<Diagnostic, "status" | "detail"> {
  const { targetIP, targetPort, transport, addresses } = evidence;
  const target = `${targetIP}:${targetPort}`;
  if (addresses?.includes(targetIP) || addresses?.includes("0.0.0.0"))
    return { status: "pass", detail: `已观察到 MC UDP 监听 ${target}` };
  if (!addresses)
    return {
      status: transportVerified ? "pass" : "warn",
      detail: transportVerified
        ? `${target} 的本机网卡有效，公网传输握手成功；未单独采集进程 UDP 绑定`
        : `${target} 的本机网卡有效，尚未采集进程 UDP 绑定；请执行高级握手检测`,
    };
  // NetherNet may create and release its ICE UDP sockets with peer sessions.
  // An idle process without a socket is not evidence that forwarding is broken.
  if (!addresses.length && transport === "nethernet")
    return {
      status: transportVerified ? "pass" : "warn",
      detail: transportVerified
        ? `${target} 的本机网卡有效；空闲时未观察到 UDP 监听，公网传输握手已验证成功`
        : `${target} 的本机网卡有效；NetherNet 可按连接创建 UDP 监听，当前未观察到，请以高级握手检测确认`,
    };
  return {
    status: "fail",
    detail: `MC 实际 UDP 绑定 ${addresses.join(", ") || "未找到"}，未监听 ${target}`,
  };
}

export function applyTunnelOverrides(
  document: any,
  privateRoot: string,
  override: any = {},
  provider: TunnelProvider = "lolia",
) {
  if (!Array.isArray(document.proxies) || !document.proxies.length)
    throw new Error("隧道配置中没有代理项");
  for (const proxy of document.proxies) {
    if (
      !["udp", "https", "http"].includes(proxy.type) &&
      !(provider === "frp-panel" && proxy.type === "tcp")
    )
      throw new Error("请导入 HTTPS 信令或 UDP 隧道");
    if (proxy.type === "tcp" && override.httpTargetPort) {
      proxy.localIP = "127.0.0.1";
      proxy.localPort = override.httpTargetPort;
    }
    if (proxy.type === "udp" && override.udpLocalIP)
      proxy.localIP = override.udpLocalIP;
    if (proxy.type === "http" && override.httpTargetPort)
      proxy.localPort = override.httpTargetPort;
    if (proxy.type === "https") {
      if (!proxy.customDomains?.length)
        throw new Error("HTTPS 信令隧道没有证书域名");
      if (proxy.plugin?.type && proxy.plugin.type !== "https2http")
        throw new Error("该 HTTPS 插件不能转换为 MC 信令代理");
      proxy.plugin = {
        ...(proxy.plugin || {}),
        type: "https2http",
        localAddr: `${proxy.localIP || "127.0.0.1"}:${override.httpTargetPort || proxy.localPort || 19132}`,
        autoTLS: {
          enable: override.enableAutoTLS !== false,
          cacheDir: path.join(privateRoot, ".autotls-cache"),
          caDirURL: "https://acme-v02.api.letsencrypt.org/directory",
        },
      };
    }
  }
  return document;
}

export class Network {
  constructor(
    private store: Store,
    private runtime: Runtime,
    private resources: string,
    private toolsRoot?: string,
  ) {}
  async routerConfigs(id: string) {
    const data = await json<SignalRouterConfig[]>(
      path.join(this.root(id), "signal-routers.json"),
      [],
    );
    for (const item of data)
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.key))
        throw new Error("转接层配置编号无效");
    return data;
  }
  private routerFile(root: string, key: string) {
    return path.join(root, "signaling", `${key}.json`);
  }
  private routerProcess(root: string, key: string) {
    const file = this.routerFile(root, key).toLowerCase();
    return this.runtime.processes.find(
      (p) => p.command?.toLowerCase().includes(file) && /python/i.test(p.name),
    );
  }
  async saveRouter(id: string, config: SignalRouterConfig) {
    const invalid = routerConfigError(config);
    if (invalid) throw new Error(invalid);
    const root = this.root(id);
    const data = await this.get(id);
    if (
      !data.tunnels.some(
        (t) => t.id === config.signalId && isSignalTunnel(t),
      ) ||
      !data.tunnels.some((t) => t.id === config.udpId && t.type === "udp")
    )
      throw new Error("请选择已导入的信令与 UDP 隧道");
    if (
      data.tunnels.some((t) => t.id === config.signalId && t.running) ||
      this.routerProcess(root, config.key)
    )
      throw new Error("请先停止该信令隧道及其转接层，再修改配置");
    const url = new URL(config.upstream);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("上游信令必须是本机回环 HTTP 地址");
    const core = await this.runtime.get(id);
    if (Number(url.port || 80) === config.listenPort)
      throw new Error("转接层上游不能指向自己的监听端口");
    if (config.listenPort === core.port)
      throw new Error("转接层监听端口不能与 MC 信令端口相同");
    for (const instance of this.store.instances()) {
      if (!instance.tunnelRoot) continue;
      const existing = await this.routerConfigs(instance.id);
      if (
        existing.some(
          (r) =>
            r.enabled &&
            config.enabled &&
            r.listenPort === config.listenPort &&
            !(instance.id === id && r.key === config.key),
        )
      )
        throw new Error("另一个转接层已配置使用该监听端口");
    }
    const routers = await this.routerConfigs(id);
    const previous = routers.find((r) => r.key === config.key);
    if (
      previous &&
      previous.signalId !== config.signalId &&
      data.tunnels.some((t) => t.id === previous.signalId && t.running)
    )
      throw new Error("请先停止原信令隧道，再更换转接层关联");
    if (
      routers.some(
        (r) => r.key !== config.key && r.signalId === config.signalId,
      )
    )
      throw new Error("每条信令隧道只能关联一个转接层");
    const overrideFile = path.join(root, "client-overrides.json");
    const overrides = await json<Record<string, any>>(overrideFile, {});
    if (previous && previous.signalId !== config.signalId)
      overrides[previous.signalId] = {
        ...overrides[previous.signalId],
        httpTargetPort: core.port,
      };
    overrides[config.signalId] = {
      ...overrides[config.signalId],
      httpTargetPort: config.enabled ? config.listenPort : core.port,
    };
    await atomicWrite(overrideFile, JSON.stringify(overrides, null, 2));
    await atomicWrite(
      path.join(root, "signal-routers.json"),
      JSON.stringify(
        [...routers.filter((r) => r.key !== config.key), config],
        null,
        2,
      ),
    );
    return { reloadRequired: true };
  }
  private async startRouter(
    id: string,
    router: SignalRouterConfig,
    ctx: JobContext,
  ) {
    const root = this.root(id),
      file = this.routerFile(root, router.key);
    const healthURL = `http://127.0.0.1:${router.listenPort}/_health`;
    const healthy = async () =>
      fetch(healthURL, { signal: AbortSignal.timeout(1000) })
        .then(
          async (r) => r.ok && ((await r.json()) as any).route === router.name,
        )
        .catch(() => false);
    if (this.routerProcess(root, router.key)) {
      if (await healthy()) return;
      throw new Error(`转接层 ${router.name} 已运行但健康检查失败`);
    }
    const shared = this.toolsRoot
      ? await json<{ python: string } | null>(
          path.join(
            this.toolsRoot,
            "runtimes",
            "signal-router",
            "current.json",
          ),
          null,
        )
      : null;
    const python = shared?.python || this.store.instance(id).python;
    if (!python || !(await exists(python)))
      throw new Error("请先在工具中心一键准备通用信令运行环境");
    const udp = (await this.get(id)).tunnels.find(
      (t) => t.id === router.udpId && t.type === "udp",
    );
    await atomicWrite(
      file,
      JSON.stringify(
        {
          ...router,
          routeName: router.name,
          localUdpIP: udp?.localIP,
          localUdpPort: udp?.localPort,
        },
        null,
        2,
      ),
    );
    await fs.mkdir(path.join(root, "logs"), { recursive: true });
    const out = await fs.open(
      path.join(root, "logs", `signaling-${router.key}.log`),
      "a",
    );
    try {
      const child = spawn(
        python,
        [
          "-u",
          path.join(this.resources, "signal-router", "router.py"),
          "--config",
          file,
          "--state",
          file + ".state",
        ],
        {
          cwd: root,
          windowsHide: true,
          detached: true,
          stdio: ["ignore", out.fd, out.fd],
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      try {
        for (let n = 0; n < 40; n++) {
          await sleep(250, ctx.signal);
          if (await healthy()) return;
        }
        throw new Error(`转接层 ${router.name} 启动超时，请查看对应日志`);
      } catch (error) {
        if (child.pid)
          try {
            process.kill(child.pid);
          } catch {}
        throw error;
      }
    } finally {
      await out.close();
    }
  }
  private root(id: string) {
    const root = this.store.instance(id).tunnelRoot;
    if (!root)
      throw new Error("尚未关联隧道目录，请在此页选择 Lolia 客户端目录");
    return root;
  }
  async attach(id: string, root: string) {
    root = await fs.realpath(root);
    await this.executable(root);
    if (!(await exists(path.join(root, "tunnel-summary.json"))))
      await atomicWrite(path.join(root, "tunnel-summary.json"), "[]");
    const i = this.store.instance(id);
    i.tunnelRoot = root;
    this.store.put("instances", i);
    return true;
  }
  async get(id: string) {
    const i = this.store.instance(id);
    if (!i.tunnelRoot)
      return {
        attached: false,
        tunnels: [],
        routes: [],
        interfaces: Object.values(os.networkInterfaces())
          .flat()
          .filter((n) => n && !n.internal && n.family === "IPv4")
          .map((n) => n!.address),
        routerHealthy: false,
      };
    const root = i.tunnelRoot;
    const summaries = await json<any[]>(
      path.join(root, "tunnel-summary.json"),
      [],
    );
    const imported = this.store.get<any[]>(`tunnel-imports:${id}`, []);
    const all = [
      ...summaries.filter((s) => !imported.some((t) => s.id === t.id)),
      ...imported,
    ];
    const tunnels: Tunnel[] = [];
    for (const item of all)
      for (const proxy of item.proxies || []) {
        const config = tunnelConfigPath(root, item).toLowerCase();
        const process = this.runtime.processes.find(
          (p) =>
            p.name.toLowerCase() === "frpc.exe" &&
            p.command?.toLowerCase().includes(config),
        );
        tunnels.push({
          id: item.id,
          provider: item.provider || "lolia",
          node: item.node || "Lolia",
          serverAddr: item.serverAddr,
          serverPort: item.serverPort,
          type: proxy.type,
          running: !!process,
          pid: process?.pid,
          localIP: proxy.localIP || "127.0.0.1",
          localPort: proxy.localPort,
          remotePort: proxy.remotePort,
          publicPort: proxy.publicPort,
          host: proxy.customDomains?.[0],
          pluginTarget: proxy.pluginLocalAddr,
          autoTLS: proxy.AutoTLS,
        });
      }
    const configured = await this.routerConfigs(id);
    const routers = await Promise.all(
      configured.map(async (r) => ({
        ...r,
        running: !!this.routerProcess(root, r.key),
        healthy:
          r.enabled &&
          (await fetch(`http://127.0.0.1:${r.listenPort}/_health`, {
            signal: AbortSignal.timeout(800),
          })
            .then(
              async (v) => v.ok && ((await v.json()) as any).route === r.name,
            )
            .catch(() => false)),
      })),
    );
    const routes: Route[] = tunnels
      .filter((t) => isSignalTunnel(t) && t.host)
      .map((signal) => {
        const configuredRouter = configured.find(
          (r) => r.enabled && r.signalId === signal.id,
        );
        const candidates = tunnels.filter(
          (t) =>
            t.type === "udp" &&
            (configuredRouter
              ? t.id === configuredRouter.udpId
              : t.node === signal.node && t.provider === signal.provider),
        );
        const udp = candidates.length === 1 ? candidates[0] : undefined;
        const summary = all.find((s) => s.id === udp?.id);
        const router = !!configuredRouter;
        return {
          name: configuredRouter?.name || signal.node,
          host: signal.host!,
          port:
            signal.type === "tcp"
              ? signal.publicPort || signal.remotePort!
              : signal.type === "https"
                ? 443
                : 80,
          protocol: signal.type === "http" ? "http" : "https",
          signalId: signal.id,
          udpId: udp?.id,
          pairingAmbiguous: candidates.length > 1,
          udpHost: configuredRouter?.publicUdpIP || summary?.serverAddr,
          udpPort: configuredRouter?.publicUdpPort || udp?.remotePort,
          signalRunning: signal.running,
          udpRunning: !!udp?.running,
          targetIP: udp?.localIP,
          targetPort: udp?.localPort,
          router,
          signalingTarget: configuredRouter
            ? `${configuredRouter.listenIP}:${configuredRouter.listenPort}`
            : signal.pluginTarget || `${signal.localIP}:${signal.localPort}`,
        };
      });
    const routerHealthy =
      routers.some((r) => r.enabled) &&
      routers.filter((r) => r.enabled).every((r) => r.healthy);
    return {
      attached: true,
      tunnels,
      routes,
      interfaces: Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => n && !n.internal && n.family === "IPv4")
        .map((n) => n!.address),
      routerHealthy,
      routers,
      endpoint: await json<any>(
        i.endpointPath || path.join(i.root, "tunnel-endpoint.json"),
        {},
      ),
    };
  }
  private async executable(
    root: string,
    provider: "lolia" | "sakura" | "frp-panel" = "lolia",
  ) {
    if (this.toolsRoot) {
      const client = await resolveTunnelClient(this.toolsRoot, provider);
      if (client.ready && client.executable) return client.executable;
      throw new Error(client.detail);
    }
    if (provider === "frp-panel")
      throw new Error(
        "请先在工具中心下载官方 FRP 客户端，云服务器线路不能使用 Lolia 或 Sakura 客户端",
      );
    if (provider === "sakura")
      throw new Error("请先在工具中心一键下载 SakuraFrp 樱花客户端");
    for (const dir of await fs.readdir(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !dir.name.startsWith("client")) continue;
      const base = path.join(root, dir.name);
      for (const sub of await fs.readdir(base, { withFileTypes: true })) {
        const candidate = path.join(base, sub.name, "frpc.exe");
        if (sub.isDirectory() && (await exists(candidate))) return candidate;
      }
      if (await exists(path.join(base, "frpc.exe")))
        return path.join(base, "frpc.exe");
    }
    if (await exists(path.join(root, "frpc.exe")))
      return path.join(root, "frpc.exe");
    throw new Error("请先在工具中心一键下载 LoliaFRP 客户端");
  }
  async action(
    id: string,
    action: "start" | "stop" | "reload",
    tunnelId: number | undefined,
    ctx: JobContext,
  ) {
    const root = this.root(id);
    let data = await this.get(id);
    const target = uniqueTunnelClients(
      data.tunnels.filter((t) => !tunnelId || t.id === tunnelId),
    );
    if (!target.length) throw new Error("没有可操作的隧道");
    // Resolve every required binary before stopping any live route on reload.
    if (action !== "stop")
      for (const tunnel of target)
        await this.executable(root, tunnel.provider || "lolia");
    if (action !== "start") {
      for (const tunnel of target) {
        if (!tunnel.pid) continue;
        const config = tunnelConfigPath(root, tunnel).toLowerCase();
        const processInfo = this.runtime.processes.find(
          (p) =>
            p.pid === tunnel.pid &&
            p.name.toLowerCase() === "frpc.exe" &&
            p.command?.toLowerCase().includes(config),
        );
        if (processInfo) process.kill(processInfo.pid);
      }
      for (const router of await this.routerConfigs(id)) {
        if (tunnelId && router.signalId !== tunnelId) continue;
        const configFile = this.routerFile(root, router.key).toLowerCase();
        for (const child of this.runtime.processes.filter(
          (p) =>
            /python/i.test(p.name) &&
            p.command?.toLowerCase().includes(configFile),
        )) {
          try {
            process.kill(child.pid);
          } catch (error: any) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
      await sleep(2500, ctx.signal);
    }
    if (action !== "stop") {
      ctx.update(15, "获取并校验隧道生效配置");
      const legacy = await json<{ tunnels: { id: number; token: string }[] }>(
        path.join(root, "private", "tunnels.private.json"),
        { tunnels: [] },
      );
      for (const tid of new Set(target.map((t) => t.id))) {
        ctx.signal.throwIfAborted();
        const tunnel = target.find((t) => t.id === tid)!;
        if (action === "start" && tunnel.running) continue;
        const encrypted = this.store.get<string | null>(
          `tunnel-secret:${id}:${tid}`,
          null,
        );
        const token = encrypted
          ? Buffer.from(
              await this.protect(encrypted, "unprotect"),
              "base64",
            ).toString("utf8")
          : legacy.tunnels.find((t) => t.id === tid)?.token;
        if (token && tunnel.provider !== "frp-panel")
          await this.import(id, tid, token, ctx, tunnel.provider || "lolia");
        else {
          const config = tunnelConfigPath(root, tunnel);
          if (!(await exists(config)))
            throw new Error(`隧道 ${tid} 没有配置，请先导入快捷启动命令`);
          const overrides = await json<Record<string, any>>(
            path.join(root, "client-overrides.json"),
            {},
          );
          const text = await fs.readFile(config, "utf8");
          await atomicWrite(
            config,
            tunnel.provider === "sakura"
              ? writeSakuraIni(
                  applySakuraOverrides(parseSakuraIni(text), overrides[tid]),
                )
              : stringify(
                  applyTunnelOverrides(
                    parse(text),
                    path.dirname(config),
                    overrides[tid],
                    tunnel.provider || "lolia",
                  ),
                ),
          );
        }
      }
      data = await this.get(id);
      for (const tunnel of uniqueTunnelClients(
        data.tunnels.filter((t) => !tunnelId || t.id === tunnelId),
      )) {
        ctx.signal.throwIfAborted();
        if (
          !isSignalTunnel(tunnel) &&
          tunnel.type !== "udp" &&
          !(tunnel.provider === "frp-panel" && tunnel.type === "tcp")
        )
          throw new Error("MC 入口需要 HTTPS 信令与 UDP 游戏隧道");
        const executable = await this.executable(
          root,
          tunnel.provider || "lolia",
        );
        const router = (await this.routerConfigs(id)).find(
          (r) => r.enabled && r.signalId === tunnel.id,
        );
        if (router) await this.startRouter(id, router, ctx);
        if (tunnel.running) continue;
        const config = tunnelConfigPath(root, tunnel);
        const clientArgs = ["-c", config];
        if (tunnel.provider === "sakura") {
          // Sakura exposes flags only; upstream FRP's `verify` subcommand is unavailable.
          const document = applySakuraOverrides(
            parseSakuraIni(await fs.readFile(config, "utf8")),
          );
          clientArgs.push("--disable_log_color", "--natfrp_tls");
          const overrides = await json<Record<string, any>>(
            path.join(root, "client-overrides.json"),
            {},
          );
          const nodeIP = overrides[tunnel.id]?.nodeIP;
          if (nodeIP) {
            if (!isIPv4(nodeIP))
              throw new Error("樱花节点 IP 覆盖必须是有效 IPv4");
            clientArgs.push(
              "--hosts",
              `${document.common.server_addr}:${nodeIP}`,
            );
          }
        } else
          await runFile(executable, ["verify", "-c", config], {
            cwd: root,
            timeout: 20000,
          });
        await fs.mkdir(path.join(root, "logs"), { recursive: true });
        const out = await fs.open(
          path.join(root, "logs", `tunnel-${tunnel.id}.log`),
          "a",
        );
        const err = await fs.open(
          path.join(root, "logs", `tunnel-${tunnel.id}.err.log`),
          "a",
        );
        try {
          const child = spawn(executable, clientArgs, {
            cwd: tunnel.provider === "sakura" ? path.dirname(config) : root,
            windowsHide: true,
            detached: true,
            stdio: ["ignore", out.fd, err.fd],
          });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          child.unref();
        } finally {
          await out.close();
          await err.close();
        }
      }
    }
    this.runtime.activity(
      id,
      `${action === "stop" ? "停止" : action === "reload" ? "重新加载" : "启动"}${tunnelId ? "隧道 " + tunnelId : "全部关联隧道"}`,
    );
    return true;
  }
  async updateTarget(id: string, tunnelId: number, ip: string) {
    if (
      !Object.values(os.networkInterfaces())
        .flat()
        .some((n) => n?.address === ip)
    )
      throw new Error("请选择本机实际存在的网卡地址");
    const root = this.root(id);
    const tunnel = (await this.get(id)).tunnels.find(
      (t) => t.id === tunnelId && t.type === "udp",
    );
    if (!tunnel) throw new Error("UDP 隧道不存在");
    const file = path.join(root, "client-overrides.json");
    const data = await json<Record<string, any>>(file, {});
    data[tunnelId] = { ...data[tunnelId], udpLocalIP: ip };
    await atomicWrite(file, JSON.stringify(data, null, 2));
    return { reloadRequired: true };
  }
  async log(id: string, tunnelId: number) {
    const root = this.root(id);
    if (!(await this.get(id)).tunnels.some((t) => t.id === tunnelId))
      throw new Error("隧道不存在");
    const { tail } = await import("./safe");
    return redact(
      (
        await tail(
          path.join(root, "logs", `tunnel-${tunnelId}.log`),
          192 * 1024,
        ).catch(() => ({ text: "" }))
      ).text,
    );
  }
  private async protect(data: string, action: "protect" | "unprotect") {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.join(this.resources, "dpapi.ps1"),
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", () => {});
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve(output.trim())
          : reject(new Error("Windows 凭证加密操作失败")),
      );
      child.stdin.end(JSON.stringify({ action, data }));
    });
  }
  async import(
    id: string,
    tunnelId: number,
    token: string,
    ctx: JobContext,
    provider: "lolia" | "sakura" | "frp-panel" = "lolia",
  ) {
    if (!/^[A-Za-z0-9_-]{12,256}$/.test(token))
      throw new Error("隧道令牌格式不正确");
    const root = this.root(id);
    const previous = (await this.get(id)).tunnels.find(
      (t) => t.id === tunnelId,
    );
    if (previous && previous.provider !== provider)
      throw new Error(
        "另一服务商已使用相同隧道编号，请使用不同编号避免覆盖现有线路",
      );
    if (previous?.running) throw new Error("请先停止该隧道再重新导入配置");
    if (provider === "frp-panel")
      throw new Error("frp-panel 配置须由面板直接导入");
    if (provider === "sakura")
      return this.importSakura(id, tunnelId, token, ctx);
    ctx.update(10, "向 Lolia 官方接口读取隧道配置");
    const url = new URL("https://api.lolia.link/api/v1/tunnel/frpc/config");
    url.searchParams.set("id", String(tunnelId));
    url.searchParams.set("token", token);
    const response = await fetch(url, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]),
      headers: { "User-Agent": "LoliaFRP-CLI 0.71.4" },
    });
    const data = (await response.json()) as any;
    if (!response.ok || !data.data?.config)
      throw new Error("无法读取该隧道，请检查编号、令牌和节点状态");
    const document = parse(
      Buffer.from(data.data.config, "base64").toString("utf8"),
    ) as any;
    const proxies = document.proxies || [];
    const privateRoot = path.join(root, "private");
    await fs.mkdir(privateRoot, { recursive: true });
    if (
      process.platform === "win32" &&
      !(await exists(path.join(privateRoot, ".ark-acl-ready")))
    ) {
      await runFile("icacls.exe", [
        privateRoot,
        "/inheritance:r",
        "/grant:r",
        `${os.userInfo().username}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ]);
      await atomicWrite(path.join(privateRoot, ".ark-acl-ready"), "1");
    }
    const overrides = await json<Record<string, any>>(
      path.join(root, "client-overrides.json"),
      {},
    );
    applyTunnelOverrides(document, privateRoot, overrides[tunnelId]);
    const imports = this.store.get<any[]>(`tunnel-imports:${id}`, []);
    const item = {
      id: tunnelId,
      provider: "lolia",
      node: data.data.node_name,
      serverAddr: document.serverAddr,
      proxies: [] as any[],
    };
    for (const proxy of proxies) {
      item.proxies.push({
        type: proxy.type,
        localIP: proxy.localIP,
        localPort: proxy.localPort,
        remotePort: proxy.remotePort,
        customDomains: proxy.customDomains,
        AutoTLS: !!proxy.plugin?.autoTLS?.enable,
        pluginLocalAddr: proxy.plugin?.localAddr,
      });
    }
    const encrypted = await this.protect(
      Buffer.from(token).toString("base64"),
      "protect",
    );
    this.store.set(`tunnel-secret:${id}:${tunnelId}`, encrypted);
    await atomicWrite(
      path.join(privateRoot, `tunnel-${tunnelId}.toml`),
      stringify(document),
    );
    this.store.set(`tunnel-imports:${id}`, [
      ...imports.filter((t) => t.id !== tunnelId),
      item,
    ]);
    return { id: tunnelId };
  }
  private async importSakura(
    id: string,
    tunnelId: number,
    token: string,
    ctx: JobContext,
  ) {
    const root = this.root(id);
    ctx.update(10, "向樱花官方接口读取隧道配置");
    const executable = await this.executable(root, "sakura");
    const version = (
      await runFile(executable, ["--version"], { timeout: 15000 })
    ).match(/\d+\.\d+\.\d+-sakura-[\w.-]+/)?.[0];
    if (!version) throw new Error("所安装的客户端不是 SakuraFrp 官方客户端");
    const tunnels = (await (
      await sakuraRequest("tunnels", token, ctx.signal)
    ).json()) as any;
    const meta =
      Array.isArray(tunnels) &&
      tunnels.find((t: any) => Number(t.id) === tunnelId);
    if (!meta) throw new Error("该樱花账户中没有此隧道");
    const nodes = (await (
      await sakuraRequest("nodes", token, ctx.signal)
    ).json()) as any;
    const node = nodes[meta.node];
    if (meta.type === "tcp" && node && Number(node.flag) & 128)
      throw new Error(
        `该节点限制高位 HTTPS 域名访问，无法作为 MC 域名信令入口：${node.description || node.name}`,
      );
    const response = await sakuraRequest("tunnel/config", token, ctx.signal, {
      query: String(tunnelId),
      frpc: version,
    });
    const overrides = await json<Record<string, any>>(
      path.join(root, "client-overrides.json"),
      {},
    );
    const document = applySakuraOverrides(
      parseSakuraIni(await response.text()),
      overrides[tunnelId],
    );
    const item = sakuraSummary(tunnelId, document, meta.node);
    if (node?.name) item.node = `SakuraFrp · ${node.name}`;
    if (
      item.proxies[0].type === "tcp" &&
      !item.serverAddr?.endsWith(".nyat.app")
    )
      throw new Error(
        "请先在樱花控制台为 TCP 绑定 nyat.app 受信任证书域名，再重新导入",
      );
    const privateRoot = path.join(root, "private");
    await fs.mkdir(privateRoot, { recursive: true });
    if (
      process.platform === "win32" &&
      !(await exists(path.join(privateRoot, ".ark-acl-ready")))
    ) {
      await runFile("icacls.exe", [
        privateRoot,
        "/inheritance:r",
        "/grant:r",
        `${os.userInfo().username}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ]);
      await atomicWrite(path.join(privateRoot, ".ark-acl-ready"), "1");
    }
    const encrypted = await this.protect(
      Buffer.from(token).toString("base64"),
      "protect",
    );
    await atomicWrite(tunnelConfigPath(root, item), writeSakuraIni(document));
    const imports = this.store.get<any[]>(`tunnel-imports:${id}`, []);
    this.store.set(`tunnel-secret:${id}:${tunnelId}`, encrypted);
    this.store.set(`tunnel-imports:${id}`, [
      ...imports.filter((t) => t.id !== tunnelId),
      item,
    ]);
    const summaries = await json<any[]>(
      path.join(root, "tunnel-summary.json"),
      [],
    );
    await atomicWrite(
      path.join(root, "tunnel-summary.json"),
      JSON.stringify(
        [...summaries.filter((t) => t.id !== tunnelId), item],
        null,
        2,
      ),
    );
    return { id: tunnelId, provider: "sakura" };
  }
  qualityReport(id: string): RouteQualityReport | null {
    this.store.instance(id);
    return this.store.get<RouteQualityReport | null>(
      `route-quality:${id}`,
      null,
    );
  }
  async quality(
    id: string,
    signalId: number | undefined,
    ctx: JobContext,
  ): Promise<RouteQualityReport> {
    const network = await this.get(id);
    const routes = network.routes.filter(
      (r) => !signalId || r.signalId === signalId,
    );
    if (!routes.length) throw new Error("没有可检测的玩家入口，请先导入线路");
    if (routes.length > 16)
      throw new Error("一次最多对比 16 条线路，请逐条检测");
    let completed = 0;
    const progress = () =>
      ctx.update(
        (++completed / (routes.length * 6)) * 95,
        `线路质量：已完成 ${completed} / ${routes.length * 6} 项采样`,
      );
    const measured: RouteQuality[] = [];
    // Limit probes to three simultaneous routes to avoid loading the MC host.
    for (let offset = 0; offset < routes.length; offset += 3) {
      measured.push(
        ...(await Promise.all(
          routes.slice(offset, offset + 3).map((route) =>
            measureRouteQuality(
              route,
              ctx,
              async () => {
                const probe = path.join(
                  this.resources,
                  "probes",
                  "route-check.exe",
                );
                if (!(await exists(probe))) throw new Error("握手探针尚未打包");
                if (!route.udpHost || !route.udpPort)
                  throw new Error("UDP 隧道尚未关联");
                const ip = await resolveUdpIPv4(route.udpHost);
                const output = await runFile(
                  probe,
                  [
                    "--url",
                    `${route.protocol || "https"}://${route.host}:${route.port}`,
                    "--expect-ip",
                    ip,
                    "--expect-port",
                    String(route.udpPort),
                    "--repeat",
                    "2",
                    "--hold",
                    "1s",
                  ],
                  { timeout: 75000, signal: ctx.signal },
                );
                const tests = output
                  .trim()
                  .split(/\r?\n/)
                  .map((line) => JSON.parse(line));
                if (
                  tests.length !== 2 ||
                  !tests.every(
                    (t) =>
                      t.ok &&
                      t.server_identity_verified &&
                      t.connection_still_open,
                  )
                )
                  throw new Error("UDP 握手、保持连接或服务端身份验证失败");
                const timings = tests
                  .map((t) => t.elapsed_ms)
                  .filter((n) => typeof n === "number" && Number.isFinite(n));
                return {
                  detail: `2 次 ICE / DTLS / SCTP 与重连成功 · UDP ${ip}:${route.udpPort}`,
                  connectMs: timings.length
                    ? Math.round(
                        timings.reduce((a, b) => a + b, 0) / timings.length,
                      )
                    : undefined,
                };
              },
              progress,
            ),
          ),
        )),
      );
    }
    ctx.signal.throwIfAborted();
    const previous = this.qualityReport(id)?.routes || [];
    const active = new Map(network.routes.map((r) => [r.signalId, r]));
    const merged = [
      ...previous.filter(
        (r) =>
          !measured.some((m) => m.signalId === r.signalId) &&
          active.get(r.signalId)?.host === r.host &&
          active.get(r.signalId)?.port === r.port,
      ),
      ...measured,
    ];
    const fresh = merged.filter((r) => Date.now() - r.checkedAt < 15 * 60000);
    const report: RouteQualityReport = {
      checkedAt: Date.now(),
      routes: merged,
      recommendedSignalId: recommendRoute(fresh),
      scope:
        "从此电脑测量，每条线路 5 次独立 HTTP(S) 信令请求（含 DNS / TLS / 响应），失败率为请求失败率；握手建连耗时包含信令与 ICE / DTLS / SCTP。未测游戏内 RTT、UDP 丢包率或带宽；未执行玩家登录。建议仅参考最近 15 分钟内通过握手的结果。",
    };
    this.store.set(`route-quality:${id}`, report);
    return report;
  }
  async diagnose(
    id: string,
    host: string,
    advanced: boolean,
    ctx: JobContext,
  ): Promise<Diagnostic[]> {
    const route = (await this.get(id)).routes.find((r) => r.host === host);
    if (!route) throw new Error("线路不存在");
    const result: Diagnostic[] = [];
    let udpEvidence: UdpBindingEvidence | undefined;
    const check = async (
      name: string,
      fn: () => Promise<string | Pick<Diagnostic, "status" | "detail">>,
    ) => {
      const start = Date.now();
      try {
        const observation = await fn();
        result.push({
          name,
          ...(typeof observation === "string"
            ? { status: "pass" as const, detail: observation }
            : observation),
          duration: Date.now() - start,
        });
      } catch (error) {
        result.push({
          name,
          status: "fail",
          detail: errorText(error),
          duration: Date.now() - start,
        });
      }
      ctx.update(Math.min(90, result.length * 13), `检测：${name}`);
    };
    await check("本机服务器", async () => {
      const s = await this.runtime.get(id);
      if (!s.pid) throw new Error("MC 进程未运行");
      return `PID ${s.pid} · ${s.world} · ${s.transport}`;
    });
    await check("隧道进程", async () => {
      if (!route.signalRunning || !route.udpRunning)
        throw new Error(
          `信令${route.signalRunning ? "运行" : "停止"} / UDP${route.udpRunning ? "运行" : "停止"}`,
        );
      return `信令 ${route.signalId} / UDP ${route.udpId} 均运行`;
    });
    await check("UDP 目标网卡", async () => {
      if (
        !Object.values(os.networkInterfaces())
          .flat()
          .some((n) => n?.address === route.targetIP)
      )
        throw new Error(`转发目标 ${route.targetIP} 已不在本机网卡上`);
      const i = this.store.instance(id);
      const s = await this.runtime.get(id);
      let addresses: string[] | undefined;
      if (i.python) {
        const code = `import psutil,json;print(json.dumps([c.laddr.ip for c in psutil.net_connections(kind='udp') if c.pid==${Number(s.pid) || 0} and c.laddr.port==${Number(route.targetPort) || 19132}]))`;
        addresses = JSON.parse(
          await runFile(i.python, ["-c", code], { timeout: 20000 }),
        );
      }
      udpEvidence = {
        targetIP: route.targetIP!,
        targetPort: route.targetPort!,
        transport: s.transport,
        addresses,
      };
      return assessUdpBinding(udpEvidence);
    });
    await check("公网 DNS", async () => {
      const records = await dns.resolve4(route.host);
      return records.join(" / ");
    });
    await check(
      "TLS 证书",
      async () =>
        new Promise<string>((resolve, reject) => {
          const socket = tls.connect(
            {
              host: route.host,
              port: route.port,
              servername: route.host,
              rejectUnauthorized: true,
            },
            () => {
              const certificate = socket.getPeerCertificate();
              socket.end();
              resolve(`受信任 · 到期 ${certificate.valid_to}`);
            },
          );
          socket.setTimeout(10000, () =>
            socket.destroy(new Error("TLS 握手超时")),
          );
          socket.once("error", reject);
        }),
    );
    await check("HTTPS 信令", async () => {
      const response = await fetch(
        `${route.protocol || "https"}://${route.host}:${route.port}/v1/join`,
        { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(12000)]) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      try {
        const metadata = JSON.parse(text);
        return `HTTP 200 · ${metadata.result?.serverName || metadata.serverName || "信令接口可达"}`;
      } catch {
        return "HTTP 200 · 信令接口可达";
      }
    });
    if (advanced)
      await check("NetherNet 公网传输握手", async () => {
        const probe = path.join(this.resources, "probes", "route-check.exe");
        if (!(await exists(probe))) throw new Error("握手探针尚未打包");
        const ip = await resolveUdpIPv4(route.udpHost!);
        const output = await runFile(
          probe,
          [
            "--url",
            `${route.protocol || "https"}://${route.host}:${route.port}`,
            "--expect-ip",
            ip,
            "--expect-port",
            String(route.udpPort),
            "--repeat",
            "2",
            "--hold",
            "1s",
          ],
          { timeout: 75000 },
        );
        const tests = output
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        if (
          tests.length !== 2 ||
          !tests.every((t) => t.ok && t.server_identity_verified)
        )
          throw new Error("握手或服务端身份验证失败");
        const binding = result.find((r) => r.name === "UDP 目标网卡");
        if (binding && udpEvidence)
          Object.assign(binding, assessUdpBinding(udpEvidence, true));
        return `连续 ${tests.length} 次 ICE / DTLS / SCTP 成功，UDP ${ip}:${route.udpPort}；未执行游戏登录`;
      });
    result.push({
      name: "真实游戏登录",
      status: "warn",
      detail:
        "自动检测不执行 Minecraft 登录。请通过此入口进服、退出后重进，并观察玩家记录。",
    });
    return result;
  }
}
