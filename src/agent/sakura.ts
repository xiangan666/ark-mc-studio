import { z } from "zod";
import { redact } from "./safe";

export type SakuraIni = Record<string, Record<string, string>>;

/** Sakura's client still consumes INI, independently of the Lolia TOML client. */
export function parseSakuraIni(text: string): SakuraIni {
  const document: SakuraIni = Object.create(null);
  let current: Record<string, string> | undefined;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const value = line.trim();
    if (!value || /^[#;]/.test(value)) continue;
    const section = /^\[([^\]\r\n]+)\]$/.exec(value);
    if (section) {
      if (document[section[1]]) throw new Error("樱花配置包含重复分节");
      current = document[section[1]] = Object.create(null);
      continue;
    }
    const field = /^([\w.-]+)\s*=\s*(.*)$/.exec(value);
    if (!current || !field) throw new Error("樱花返回的 INI 配置格式不正确");
    if (Object.hasOwn(current, field[1]))
      throw new Error("樱花配置包含重复参数");
    current[field[1]] = field[2];
  }
  if (!document.common || Object.keys(document).length !== 2)
    throw new Error("请一次导入一条樱花隧道");
  return document;
}

export function writeSakuraIni(document: SakuraIni) {
  return (
    Object.entries(document)
      .map(
        ([name, fields]) =>
          `[${name}]\n${Object.entries(fields)
            .map(([key, value]) => `${key} = ${value}`)
            .join("\n")}`,
      )
      .join("\n\n") + "\n"
  );
}

export function applySakuraOverrides(document: SakuraIni, override: any = {}) {
  const proxy = Object.entries(document).find(
    ([name]) => name !== "common",
  )?.[1];
  if (!proxy || !["tcp", "udp"].includes(proxy.type))
    throw new Error("樱花 MC 入口支持自动 HTTPS 的 TCP 信令与 UDP 隧道");
  if (proxy.type === "tcp") {
    if (proxy.auto_https !== "auto")
      throw new Error(
        "请先在樱花控制台开启 TCP 自动 HTTPS，并绑定受信任的域名证书",
      );
    proxy.auto_https_mode = "http";
    if (override.httpTargetPort) {
      proxy.local_ip = "127.0.0.1";
      proxy.local_port = String(override.httpTargetPort);
    }
  } else if (override.udpLocalIP) proxy.local_ip = override.udpLocalIP;
  if (!z.ipv4().safeParse(proxy.local_ip).success)
    throw new Error("樱花隧道本机目标必须是 IPv4 地址");
  for (const key of ["local_port", "remote_port"])
    if (
      !/^\d+$/.test(proxy[key]) ||
      Number(proxy[key]) < 1 ||
      Number(proxy[key]) > 65535
    )
      throw new Error("樱花隧道端口无效");
  return document;
}

export const sakuraApi = "https://api.natfrp.com/v4";
export async function sakuraRequest(
  endpoint: string,
  token: string,
  signal: AbortSignal,
  body?: Record<string, string>,
) {
  const response = await fetch(`${sakuraApi}/${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      "User-Agent": "ArkMC-Studio",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    redirect: "error",
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as any;
    const detail =
      typeof error?.msg === "string"
        ? redact(error.msg.replaceAll(token, "[已隐藏]")).slice(0, 350)
        : "请检查访问密钥及隧道权限";
    throw new Error(`樱花官方接口请求失败 HTTP ${response.status}：${detail}`);
  }
  return response;
}

export function sakuraSummary(
  tunnelId: number,
  document: SakuraIni,
  node: number,
) {
  const proxy = Object.entries(document).find(
    ([name]) => name !== "common",
  )![1];
  const common = document.common;
  return {
    id: tunnelId,
    provider: "sakura" as const,
    node: `SakuraFrp · 节点 ${node}`,
    serverAddr: common.server_addr,
    proxies: [
      {
        type: proxy.type,
        localIP: proxy.local_ip,
        localPort: Number(proxy.local_port),
        remotePort: Number(proxy.remote_port),
        customDomains: proxy.type === "tcp" ? [common.server_addr] : undefined,
        AutoTLS: proxy.type === "tcp" && proxy.auto_https === "auto",
        pluginLocalAddr:
          proxy.type === "tcp"
            ? `${proxy.local_ip}:${proxy.local_port}`
            : undefined,
      },
    ],
  };
}
