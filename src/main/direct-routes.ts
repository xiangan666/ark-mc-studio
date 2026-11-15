import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import https from "node:https";
import { isIPv6 } from "node:net";
import { spawn } from "node:child_process";
import {
  controlPipe,
  directConfigSchema,
  publicIPv6,
} from "../direct/protocol";
import type { DirectConfig } from "../direct/protocol";
import type { DirectRouteStatus } from "../shared/direct";
import type { AgentClient } from "./agent-client";
import type { Bootstrap } from "../shared/types";

async function publicAAAA(domain: string) {
  // DNS over HTTPS prevents local VPN fake-IP DNS from masquerading as the
  // public AAAA record, even when it intercepts UDP queries to public resolvers.
  for (const origin of [
    "https://dns.alidns.com/resolve",
    "https://cloudflare-dns.com/dns-query",
  ]) {
    try {
      const response = await fetch(
        `${origin}?name=${encodeURIComponent(domain)}&type=AAAA`,
        {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) continue;
      const result = (await response.json()) as {
        Status?: number;
        Answer?: { type: number; data: string }[];
      };
      if (result.Status !== 0) continue;
      return (result.Answer || [])
        .filter((answer) => answer.type === 28 && isIPv6(answer.data))
        .map((answer) => answer.data);
    } catch {}
  }
  return [];
}

export function directControl(root: string, token: string, action = "status") {
  return new Promise<DirectRouteStatus>((resolve, reject) => {
    const socket = net.createConnection(controlPipe(root));
    let result = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("直连服务响应超时"));
    }, 2500);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token, action }) + "\n"),
    );
    socket.on("data", (chunk) => {
      result += chunk.toString();
      if (result.length > 32768) socket.destroy(new Error("无效的直连状态"));
      if (!result.includes("\n")) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(result.trim()));
      } catch {
        reject(new Error("无效的直连状态"));
      }
    });
    socket.on("end", () => {
      clearTimeout(timer);
      if (!result.includes("\n")) reject(new Error("直连服务拒绝请求"));
    });
  });
}

export class DirectRoutes {
  private operations = new Map<string, Promise<unknown>>();
  get isBusy() {
    return this.operations.size > 0;
  }
  private dnsCache = new Map<
    string,
    {
      key: string;
      at: number;
      value: Promise<NonNullable<DirectRouteStatus["ddns"]>>;
    }
  >();
  constructor(
    private agent: AgentClient,
    private toolsRoot: string,
    private node: string,
    private bundle: string,
    private probe: string,
    private resolveAAAA: (domain: string) => Promise<string[]> = publicAAAA,
  ) {}
  private root(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("无效的实例编号");
    return path.join(this.toolsRoot, "direct", id);
  }
  private async config(id: string): Promise<DirectConfig | null> {
    const state = await this.agent.call<Bootstrap>("bootstrap");
    if (!state.instances.some((instance) => instance.id === id))
      throw new Error("实例不存在");
    try {
      return directConfigSchema.parse(
        JSON.parse(
          await fs.readFile(path.join(this.root(id), "route.json"), "utf8"),
        ),
      );
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw new Error("IPv6 直连配置格式错误，请检查 route.json");
    }
  }
  async get(id: string): Promise<DirectRouteStatus> {
    const config = await this.config(id);
    if (!config) return { configured: false };
    const base: DirectRouteStatus = {
      configured: true,
      enabled: config.enabled,
      running: false,
      ready: false,
      name: config.name,
      domain: config.domain,
      httpsPort: config.httpsPort,
      udpPort: config.udpPort,
      publicIPv6: publicIPv6(config),
    };
    const state = {
      ...base,
      ...(await directControl(this.root(id), config.controlToken).catch(
        () => ({}),
      )),
    };
    const key = `${config.domain}|${state.publicIPv6}`;
    let dns = this.dnsCache.get(id);
    if (!dns || dns.key !== key || Date.now() - dns.at > 60000) {
      const value = (async () => {
        const addresses = await this.resolveAAAA(config.domain).catch(() => []);
        const canonical = (v: string) => {
          try {
            return new URL(`http://[${v}]`).hostname;
          } catch {
            return "";
          }
        };
        return {
          addresses,
          ok:
            !!state.publicIPv6 &&
            addresses.some(
              (v) => canonical(v) === canonical(state.publicIPv6!),
            ),
          checkedAt: new Date().toISOString(),
        };
      })();
      dns = { key, at: Date.now(), value };
      this.dnsCache.set(id, dns);
    }
    state.ddns = await dns.value;
    state.diagnostic = await fs
      .readFile(path.join(this.root(id), "diagnosis.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    return state;
  }
  async restore() {
    const state = await this.agent.call<Bootstrap>("bootstrap");
    for (const instance of state.instances) {
      const config = await this.config(instance.id).catch(() => null);
      if (config?.enabled)
        await this.action(instance.id, "start").catch((error) =>
          console.warn("IPv6 direct route:", error.message),
        );
    }
  }
  async action(id: string, action: string): Promise<DirectRouteStatus> {
    if (!["start", "stop", "restart"].includes(action))
      throw new Error("无效的直连操作");
    const previous = this.operations.get(id) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const config = await this.config(id);
        if (!config) throw new Error("尚未配置 IPv6 直连线路");
        const root = this.root(id);
        const current = await directControl(root, config.controlToken).catch(
          () => null,
        );
        // Reopening an upgraded desktop must not rewrite or reload a live route.
        if (action === "start" && config.enabled && current)
          return this.get(id);
        if (action === "stop" || action === "restart") {
          if (current) {
            await directControl(root, config.controlToken, "stop");
            for (let n = 0; n < 30; n++) {
              await new Promise((r) => setTimeout(r, 100));
              if (
                !(await directControl(root, config.controlToken).catch(
                  () => null,
                ))
              )
                break;
              if (n === 29) throw new Error("直连服务尚未退出，请稍后重试");
            }
          }
          config.enabled = action !== "stop";
        } else config.enabled = true;
        await fs.writeFile(
          path.join(root, "route.json.tmp"),
          JSON.stringify(config, null, 2),
        );
        await fs.rename(
          path.join(root, "route.json.tmp"),
          path.join(root, "route.json"),
        );
        if (action === "stop") return this.get(id);
        if (action === "start" && current) return this.get(id);
        // Detached, stable runtime files keep this service alive when the desktop exits.
        const output = await fs.open(path.join(root, "host.log"), "a");
        try {
          const child = spawn(this.node, [this.bundle, "--root", root], {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", output.fd, output.fd],
          });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          child.unref();
        } finally {
          await output.close();
        }
        for (let n = 0; n < 50; n++) {
          await new Promise((r) => setTimeout(r, 150));
          const state = await directControl(root, config.controlToken).catch(
            () => null,
          );
          if (state?.ready) return this.get(id);
        }
        throw new Error("IPv6 直连启动失败，请检查证书、端口占用及 host.log");
      });
    this.operations.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.operations.get(id) === operation) this.operations.delete(id);
    }
  }
  async diagnose(id: string, advanced = false) {
    const state = await this.get(id);
    if (!state.configured) throw new Error("尚未配置 IPv6 直连线路");
    const ip = state.publicIPv6 || "";
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    checks.push({
      name: "本机固定公网 IPv6",
      ok: !!ip,
      detail: ip || "未找到配置网卡上的 DHCPv6 地址",
    });
    const addresses = state.ddns?.addresses || [];
    // IPv6 spelling varies between DNS and interface APIs; compare URL normalization.
    const canonical = (v: string) => {
      try {
        return new URL(`http://[${v}]`).hostname;
      } catch {
        return "";
      }
    };
    checks.push({
      name: "DDNS 公共解析",
      ok: !!ip && addresses.some((v) => canonical(v) === canonical(ip)),
      detail: addresses.join(", ") || "公共 DNS 无 AAAA 记录",
    });
    const tls = ip
      ? await new Promise<{ ok: boolean; detail: string }>((resolve) => {
          const request = https.get(
            {
              hostname: ip,
              port: state.httpsPort,
              servername: state.domain,
              path: "/v1/join",
              timeout: 10000,
            },
            (response) => {
              response.resume();
              resolve({
                ok: response.statusCode === 200,
                detail: `TLS 证书校验通过；信令 HTTP ${response.statusCode}`,
              });
            },
          );
          request.on("timeout", () => request.destroy(new Error("timeout")));
          request.on("error", () =>
            resolve({ ok: false, detail: "HTTPS 证书或信令连接失败" }),
          );
        })
      : { ok: false, detail: "本机公网 IPv6 不可用" };
    checks.push({ name: "HTTPS 与内核信令", ...tls });
    if (advanced && state.ready && ip) {
      const result = await new Promise<{ ok: boolean; detail: string }>(
        (resolve) => {
          const child = spawn(
            this.probe,
            [
              "-url",
              `https://${state.domain}:${state.httpsPort}`,
              "-expect-ip",
              ip,
              "-expect-port",
              `${state.udpPort}`,
              "-hold",
              "2s",
            ],
            { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
          );
          let output = "";
          const timer = setTimeout(() => {
            child.kill();
            resolve({ ok: false, detail: "传输握手检测超时" });
          }, 45000);
          child.stdout.on("data", (data) => {
            if (output.length < 16000) output += data.toString();
          });
          child.on("error", () => {
            clearTimeout(timer);
            resolve({ ok: false, detail: "网络探针不可用" });
          });
          child.on("exit", (code) => {
            clearTimeout(timer);
            try {
              const result = JSON.parse(output.trim());
              const ok =
                code === 0 &&
                result.ok === true &&
                result.connection_still_open === true;
              resolve({
                ok,
                detail: ok
                  ? `已验证 UDP [${result.selected_udp_address}]:${result.selected_udp_port}，服务器身份及 ICE / DTLS / SCTP 握手通过。`
                  : "传输握手失败，请检查 UDP 防火墙、网卡与内核端口。",
              });
            } catch {
              resolve({ ok: false, detail: "传输握手失败或探针返回无效结果" });
            }
          });
        },
      );
      checks.push({ name: "IPv6 ICE / DTLS / SCTP", ...result });
    }
    const report = {
      checks,
      testedAt: new Date().toISOString(),
      scope: "检测从本机发起；公网入站及真实账号进服仍需外网 IPv6 客户端验证。",
    };
    await fs.writeFile(
      path.join(this.root(id), "diagnosis.json"),
      JSON.stringify(report, null, 2),
    );
    return report;
  }
}
