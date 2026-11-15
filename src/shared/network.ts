import type { SignalRouterConfig, ToolId, Tunnel } from "./types";

export type TunnelProvider = NonNullable<Tunnel["provider"]>;
export const tunnelClients: Record<
  TunnelProvider,
  { tool: ToolId; name: string; format: string }
> = {
  lolia: { tool: "lolia", name: "LoliaFRP", format: "TOML" },
  sakura: { tool: "sakura", name: "SakuraFrp", format: "INI" },
  "frp-panel": { tool: "frp", name: "官方 FRP", format: "TOML" },
};

export function uniqueTunnelClients<T extends Pick<Tunnel, "id" | "provider">>(
  tunnels: T[],
): T[] {
  return [
    ...new Map(
      tunnels.map((t) => [`${t.provider || "lolia"}:${t.id}`, t]),
    ).values(),
  ];
}

export function routerConfigError(config: SignalRouterConfig): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.key)) return "转接层配置编号无效";
  if (
    !config.name.trim() ||
    config.name.length > 100 ||
    /[\r\n]/.test(config.name)
  )
    return "请输入有效的线路名称";
  if (
    ![config.signalId, config.udpId].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    return "请选择信令与 UDP 隧道";
  if (config.listenIP !== "127.0.0.1") return "信令监听必须使用本机回环地址";
  if (
    !Number.isInteger(config.listenPort) ||
    config.listenPort < 1024 ||
    config.listenPort > 65535
  )
    return "本机监听端口应为 1024–65535";
  if (
    ![config.sourceUdpPort, config.publicUdpPort].every(
      (n) => Number.isInteger(n) && n > 0 && n <= 65535,
    )
  )
    return "UDP 端口应为 1–65535";
  const ipv4 = (s: string) =>
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(s) &&
    s.split(".").every((v) => +v <= 255 && String(+v) === v);
  if (!ipv4(config.sourceUdpIP) || !ipv4(config.publicUdpIP))
    return "原始与公网 UDP 地址必须是有效的 IPv4 地址";
  try {
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
      return "上游信令必须是本机回环 HTTP 地址";
    if (+(url.port || 80) === config.listenPort)
      return "转接层上游不能指向自己的监听端口";
  } catch {
    return "请输入有效的 MC 信令地址";
  }
  return "";
}
