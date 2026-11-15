import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import { X509Certificate } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  controlPipe,
  directConfigSchema,
  iceUfrag,
  publicIPv6Addresses,
  relayOffer,
  rewriteAnswer,
  stunUsername,
} from "./protocol";
import type { DirectRouteStatus } from "../shared/direct";

const root = path.resolve(
  process.argv[process.argv.indexOf("--root") + 1] || "",
);
const limit = 256 * 1024;
const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
  "accept-encoding",
  "content-encoding",
  "etag",
]);
async function main() {
  const config = directConfigSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, "route.json"), "utf8")),
  );
  if (!config.enabled) return;
  const certPath = path.join(
    root,
    "acme",
    "certificates",
    `${config.domain}.crt`,
  );
  const keyPath = path.join(
    root,
    "acme",
    "certificates",
    `${config.domain}.key`,
  );
  const status: DirectRouteStatus = {
    configured: true,
    enabled: true,
    running: true,
    ready: false,
    name: config.name,
    domain: config.domain,
    httpsPort: config.httpsPort,
    udpPort: config.udpPort,
    pid: process.pid,
    receivedBytes: 0,
    sentBytes: 0,
    certificateRenewal: "等待定时检查",
  };
  const tls = async () => {
    const cert = await fs.readFile(certPath),
      key = await fs.readFile(keyPath);
    const parsed = new X509Certificate(cert);
    if (
      !parsed.checkHost(config.domain) ||
      Date.parse(parsed.validTo) <= Date.now()
    )
      throw new Error("HTTPS 证书域名不匹配或已过期");
    status.certificateExpires = parsed.validTo;
    return { cert, key, minVersion: "TLSv1.2" as const };
  };
  const answers = new Map<string, number>();
  const sessions = new Map<
    string,
    {
      socket: dgram.Socket;
      at: number;
      username: string;
      connected: boolean;
      queue: Buffer[];
    }
  >();
  const attempts = new Map<string, { at: number; count: number }>();
  let udp: dgram.Socket | undefined;
  let boundIP = "",
    rebinding = false;
  function onPacket(packet: Buffer, remote: dgram.RemoteInfo) {
    if (
      !status.publicIPv6 ||
      packet.length > 8192 ||
      !/^[23]/.test(remote.address)
    )
      return;
    const key = `${remote.address}%${remote.port}`;
    let session = sessions.get(key);
    const username = stunUsername(packet);
    if (session && username && username !== session.username) {
      session.socket.close();
      sessions.delete(key);
      session = undefined;
    }
    if (!session) {
      if (
        !username ||
        (answers.get(username) || 0) < Date.now() ||
        sessions.size >= 256
      )
        return;
      const socket = dgram.createSocket("udp4");
      const entry = {
        socket,
        at: Date.now(),
        username,
        connected: false,
        queue: [packet],
      };
      sessions.set(key, entry);
      socket.on("error", () => {
        if (sessions.get(key) === entry) sessions.delete(key);
        try {
          socket.close();
        } catch {}
      });
      socket.on("message", (data) => {
        entry.at = Date.now();
        status.sentBytes! += data.length;
        udp?.send(data, remote.port, remote.address, () => {});
      });
      socket.bind(0, config.localIPv4, () =>
        socket.connect(config.localUdpPort, config.localIPv4, () => {
          if (sessions.get(key) === entry) {
            entry.connected = true;
            for (const item of entry.queue) socket.send(item, () => {});
            entry.queue = [];
          }
        }),
      );
      status.receivedBytes! += packet.length;
      return;
    }
    session.at = Date.now();
    status.receivedBytes! += packet.length;
    if (session.connected) session.socket.send(packet, () => {});
    else if (session.queue.length < 16) session.queue.push(packet);
  }
  async function refreshUDP() {
    if (rebinding) return;
    rebinding = true;
    try {
      const candidates = publicIPv6Addresses(config);
      let ip = candidates[0] || "";
      if (candidates.length > 1 && process.platform === "win32") {
        // During renumbering Windows may retain a deprecated prefix. Prefer an
        // address still marked Preferred, never the first stale interface entry.
        const preferred = await new Promise<string[]>((resolve) => {
          execFile(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "@(Get-NetIPAddress -AddressFamily IPv6 -AddressState Preferred -ErrorAction Stop | Select-Object -ExpandProperty IPAddress) | ConvertTo-Json -Compress",
            ],
            { windowsHide: true, timeout: 5000 },
            (error, stdout) => {
              try {
                const value = JSON.parse(stdout);
                resolve(error ? [] : Array.isArray(value) ? value : [value]);
              } catch {
                resolve([]);
              }
            },
          );
        });
        ip = candidates.find((value) => preferred.includes(value)) || "";
      }
      status.publicIPv6 = ip;
      if (ip === boundIP && udp) return;
      if (udp) {
        udp.close();
        udp = undefined;
      }
      for (const value of sessions.values()) value.socket.close();
      sessions.clear();
      boundIP = "";
      status.ready = false;
      if (!ip) return;
      const socket = dgram.createSocket({ type: "udp6", ipv6Only: true });
      socket.on("message", onPacket);
      socket.on("error", () => {
        status.error = "IPv6 UDP 监听异常，等待重试";
        status.ready = false;
        if (udp === socket) {
          udp = undefined;
          boundIP = "";
        }
        try {
          socket.close();
        } catch {}
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind({ address: ip, port: config.udpPort }, () => {
          socket.off("error", reject);
          resolve();
        });
      });
      udp = socket;
      boundIP = ip;
      status.ready = true;
      delete status.error;
    } catch {
      status.error = "IPv6 UDP 端口不可用，等待重试";
    } finally {
      rebinding = false;
    }
  }
  let active = 0;
  const server = https.createServer(await tls(), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      !["GET", "POST"].includes(req.method || "") ||
      !/^\/v1\/join(?:\/[0-9]+)?$/.test(req.url || "")
    ) {
      res.writeHead(404).end();
      return;
    }
    const ip = boundIP;
    if (!ip || !status.ready) {
      res.writeHead(503).end("IPv6 address unavailable");
      return;
    }
    const remote = req.socket.remoteAddress || "";
    let budget = attempts.get(remote);
    if (!budget || budget.at + 60000 < Date.now()) {
      budget = { at: Date.now(), count: 0 };
      attempts.set(remote, budget);
    }
    if (++budget.count > 120 || active >= 64 || attempts.size > 4096) {
      res.writeHead(429).end();
      return;
    }
    active++;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > limit) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const original = Buffer.concat(chunks).toString("utf8");
      const offer = req.method === "POST" && req.url !== "/v1/join";
      const body = offer ? relayOffer(original) : original;
      const blocked = new Set([
        ...hop,
        ...(req.headers.connection || "")
          .toLowerCase()
          .split(",")
          .map((v) => v.trim()),
      ]);
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([key]) => !blocked.has(key)),
      );
      headers["accept-encoding"] = "identity";
      const result = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        data: Buffer;
      }>((resolve, reject) => {
        const up = http.request(
          {
            hostname: "127.0.0.1",
            port: config.upstreamPort,
            method: req.method,
            path: req.url,
            headers,
            timeout: 35000,
          },
          (response) => {
            const output: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit)
                response.destroy(new Error("Upstream too large"));
              else output.push(chunk);
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode || 502,
                headers: response.headers,
                data: Buffer.concat(output),
              }),
            );
            response.on("error", reject);
          },
        );
        req.on("aborted", () => up.destroy());
        up.on("timeout", () => up.destroy(new Error("Upstream timeout")));
        up.on("error", reject);
        up.end(body);
      });
      let data = result.data;
      if (
        offer &&
        result.status === 200 &&
        data.subarray(0, 2).toString() === "v="
      ) {
        const answer = data.toString("utf8"),
          client = iceUfrag(original),
          serverUfrag = iceUfrag(answer);
        if (!client || answers.size >= 2048)
          throw new Error("ICE session limit or invalid offer");
        data = Buffer.from(rewriteAnswer(answer, ip, config));
        answers.set(`${serverUfrag}:${client}`, Date.now() + 120000);
      }
      const outgoing = Object.fromEntries(
        Object.entries(result.headers).filter(([key]) => !hop.has(key)),
      );
      res.writeHead(result.status, {
        ...outgoing,
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end("Signaling route unavailable");
    } finally {
      active--;
    }
  });
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;
  server.on("clientError", (_error, socket) => socket.destroy());
  let stopping = false;
  const control = net.createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    let text = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (text.length > 1024) {
        socket.destroy();
        return;
      }
      if (!text.includes("\n")) return;
      try {
        const message = JSON.parse(text.trim());
        if (message.token !== config.controlToken) {
          socket.destroy();
          return;
        }
        if (message.action === "stop") {
          socket.end('{"ok":true}\n');
          if (!stopping) {
            stopping = true;
            setTimeout(() => process.exit(0), 100);
          }
        } else if (message.action === "status") {
          socket.end(
            JSON.stringify({
              ...status,
              publicIPv6: status.publicIPv6,
              sessions: sessions.size,
            }) + "\n",
          );
        } else socket.destroy();
      } catch {
        socket.destroy();
      }
    });
  });
  const listen = (target: net.Server, options: any) =>
    new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      const done = () => {
        target.off("error", reject);
        resolve();
      };
      target.listen(options, done);
    });
  await listen(control, controlPipe(root)); // Exclusive ownership before public listeners.
  await listen(server, { host: "::", port: config.httpsPort, ipv6Only: true });
  await refreshUDP();
  setInterval(() => {
    const now = Date.now();
    void refreshUDP();
    for (const [key, expires] of answers)
      if (expires < now) answers.delete(key);
    for (const [key, value] of sessions)
      if (value.at + 180000 < now) {
        value.socket.close();
        sessions.delete(key);
      }
    for (const [key, value] of attempts)
      if (value.at + 60000 < now) attempts.delete(key);
  }, 15000).unref();
  async function renew() {
    if (!config.renewal) {
      status.certificateRenewal = "未配置自动续期";
      return;
    }
    if (
      Date.parse(status.certificateExpires || "") - Date.now() >
      30 * 86400000
    ) {
      status.certificateRenewal = "证书有效，距到期 30 天内自动续期";
      return;
    }
    status.certificateRenewal = "正在续期";
    try {
      const protectedToken = await fs.readFile(
        path.join(root, "cloudflare.dpapi"),
        "utf8",
      );
      const invoke = (
        file: string,
        args: string[],
        input?: string,
        env?: NodeJS.ProcessEnv,
      ) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(file, args, {
            windowsHide: true,
            env: env || process.env,
            stdio: ["pipe", "pipe", "ignore"],
          });
          let output = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("timeout"));
          }, 8 * 60000);
          child.stdout.on("data", (s) => {
            if (output.length < limit) output += s.toString();
          });
          child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            code === 0 ? resolve(output) : reject(new Error("renewal failed"));
          });
          child.stdin.on("error", () => {});
          child.stdin.end(input || "");
        });
      const decrypted = await invoke(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-File", config.renewal.dpapiScript],
        JSON.stringify({ action: "unprotect", data: protectedToken.trim() }),
      );
      const token = Buffer.from(decrypted.trim(), "base64").toString("utf8");
      await invoke(
        config.renewal.lego,
        [
          "run",
          "--accept-tos",
          "--account-id",
          "arkmc-direct",
          "--domains",
          config.domain,
          "--dns",
          "cloudflare",
          "--dns.resolvers",
          "223.5.5.5:53,119.29.29.29:53",
          "--dns.propagation.wait",
          "30s",
          "--renew-days",
          "30",
          "--path",
          path.join(root, "acme"),
        ],
        undefined,
        {
          ...process.env,
          CLOUDFLARE_DNS_API_TOKEN: token,
          CLOUDFLARE_ZONE_API_TOKEN: token,
        },
      );
      server.setSecureContext(await tls());
      status.certificateRenewal = `续期检查完成 ${new Date().toISOString()}`;
    } catch {
      status.certificateRenewal =
        "自动续期失败，12 小时后重试；请检查 Cloudflare 令牌与网络";
    }
  }
  void renew();
  setInterval(() => void renew(), 12 * 3600000).unref();
  console.log(
    `${new Date().toISOString()} IPv6 direct route ready :${config.httpsPort} / UDP ${config.udpPort}`,
  );
}
main().catch((error) => {
  console.error(
    `${new Date().toISOString()} Direct route failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exit(1);
});
