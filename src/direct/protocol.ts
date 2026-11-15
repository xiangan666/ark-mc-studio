import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { z } from "zod";

const port = z.number().int().min(1).max(65535);
export const directConfigSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    name: z.string().trim().min(1).max(80),
    domain: z
      .string()
      .regex(
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/,
      ),
    httpsPort: port,
    udpPort: port,
    upstreamPort: port,
    localIPv4: z.string().refine(isIPv4),
    localUdpPort: port,
    interfaceName: z.string().min(1).max(100),
    hostId: z.string().regex(/^[0-9a-f]{1,4}$/),
    controlToken: z.string().regex(/^[a-f0-9]{64}$/),
    renewal: z
      .object({ lego: z.string().min(1), dpapiScript: z.string().min(1) })
      .optional(),
  })
  .strict();
export type DirectConfig = z.infer<typeof directConfigSchema>;

export function controlPipe(root: string) {
  const id = createHash("sha256")
    .update(root.toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\arkmc-direct-${id}`
    : `${root}/control.sock`;
}

export function publicIPv6(
  config: Pick<DirectConfig, "interfaceName" | "hostId">,
) {
  return publicIPv6Addresses(config)[0] || "";
}

export function publicIPv6Addresses(
  config: Pick<DirectConfig, "interfaceName" | "hostId">,
) {
  const suffix = parseInt(config.hostId, 16).toString(16);
  return (networkInterfaces()[config.interfaceName] || [])
    .filter(
      (item) =>
        item.family === "IPv6" &&
        /^[23][0-9a-f]*:/i.test(item.address) &&
        item.address.toLowerCase().endsWith(`::${suffix}`),
    )
    .map((item) => item.address);
}

export function relayOffer(body: string) {
  if (!body.startsWith("v=")) return body;
  let inserted = false;
  return body
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.startsWith("a=candidate:")) {
        const p = line.split(/\s+/);
        if (inserted || p.length < 8 || p[2].toLowerCase() !== "udp") return [];
        inserted = true;
        p[4] = "192.0.2.1";
        p[5] = "9";
        return [p.join(" ")];
      }
      if (line.startsWith("c=")) return ["c=IN IP4 192.0.2.1"];
      if (line.startsWith("m=application "))
        return [
          line.replace(
            /^(m=application )\d+/,
            (_s, prefix: string) => `${prefix}9`,
          ),
        ];
      return [line];
    })
    .join("\r\n");
}

export function iceUfrag(sdp: string) {
  return /^a=ice-ufrag:([a-zA-Z0-9+/]{1,256})\r?$/m.exec(sdp)?.[1] || "";
}

// Only a candidate backed by the explicitly configured local core endpoint is accepted.
// No arbitrary address/port from a public request may become a UDP forwarding target.
export function rewriteAnswer(
  body: string,
  ip: string,
  config: Pick<DirectConfig, "udpPort" | "localIPv4" | "localUdpPort">,
) {
  const lines = body.split(/\r?\n/);
  const template = lines
    .filter((s) => s.startsWith("a=candidate:"))
    .map((s) => s.split(/\s+/))
    .find((p) => {
      if (p.length < 8 || p[2].toLowerCase() !== "udp") return false;
      const raddr = p.indexOf("raddr"),
        rport = p.indexOf("rport");
      return (
        (p[4] === config.localIPv4 && +p[5] === config.localUdpPort) ||
        (raddr >= 0 &&
          rport >= 0 &&
          p[raddr + 1] === config.localIPv4 &&
          +p[rport + 1] === config.localUdpPort)
      );
    });
  if (!template || !iceUfrag(body))
    throw new Error("内核未公布配置的本机 UDP 端点，请检查服务器端口");
  // Construct a host candidate; remove stale IPv4 raddr/rport and interface metadata.
  const candidate = `${template[0]} ${template[1]} udp ${template[3]} ${ip} ${config.udpPort} typ host`;
  let inserted = false;
  return lines
    .flatMap((line) => {
      if (line.startsWith("a=candidate:")) {
        if (inserted) return [];
        inserted = true;
        return [candidate];
      }
      if (line.startsWith("c=")) return [`c=IN IP6 ${ip}`];
      if (line.startsWith("m=application "))
        return [line.replace(/^(m=application )\d+/, `$1${config.udpPort}`)];
      return [line];
    })
    .join("\r\n");
}

export function stunUsername(packet: Buffer) {
  if (
    packet.length < 20 ||
    packet.readUInt16BE(0) !== 1 ||
    packet.readUInt32BE(4) !== 0x2112a442
  )
    return "";
  const end = 20 + packet.readUInt16BE(2);
  if (end !== packet.length || end % 4 !== 0) return "";
  for (let offset = 20; offset + 4 <= end;) {
    const type = packet.readUInt16BE(offset),
      length = packet.readUInt16BE(offset + 2);
    if (offset + 4 + length > end) return "";
    if (type === 6)
      return length <= 513
        ? packet.subarray(offset + 4, offset + 4 + length).toString("utf8")
        : "";
    offset += 4 + ((length + 3) & ~3);
  }
  return "";
}
