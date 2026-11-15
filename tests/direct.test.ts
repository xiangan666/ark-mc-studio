import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { DirectRoutes, directControl } from "../src/main/direct-routes";
import {
  directConfigSchema,
  controlPipe,
  iceUfrag,
  relayOffer,
  rewriteAnswer,
  stunUsername,
} from "../src/direct/protocol";

const protectedLines = [
  "a=fingerprint:sha-256 AB:CD:EF",
  "a=identity:signed-identity",
  "a=ice-ufrag:server123",
  "a=ice-pwd:do-not-change-these-bytes",
];
const answer = [
  "v=0",
  "m=application 19132 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 203.0.113.24",
  ...protectedLines,
  "a=candidate:1 1 udp 1685593855 203.0.113.24 19132 typ srflx raddr 192.168.1.144 rport 19132 generation 0",
  "a=candidate:2 1 udp 1685593854 198.18.0.1 19132 typ host",
  "",
].join("\r\n");
const config = {
  udpPort: 19139,
  localIPv4: "192.168.1.144",
  localUdpPort: 19132,
};

test("IPv6 answer uses only the configured core endpoint and preserves signed identity and ICE credentials", () => {
  const result = rewriteAnswer(answer, "2001:db8::38b", config);
  assert.match(result, /m=application 19139 UDP\/DTLS\/SCTP/);
  assert.match(result, /c=IN IP6 2001:db8::38b/);
  assert.equal(
    result.split("\r\n").filter((line) => line.startsWith("a=candidate:"))
      .length,
    1,
  );
  assert.match(result, /2001:db8::38b 19139 typ host/);
  assert(!result.includes("raddr"));
  for (const line of protectedLines) assert(result.includes(line + "\r\n"));
  assert.equal(iceUfrag(result), "server123");
  assert.throws(() =>
    rewriteAnswer(answer, "2001:db8::38b", { ...config, localUdpPort: 22 }),
  );
  assert.throws(() =>
    rewriteAnswer(answer, "2001:db8::38b", {
      ...config,
      localIPv4: "127.0.0.1",
    }),
  );
  assert.throws(() => rewriteAnswer("Not an SDP", "2001:db8::38b", config));
});

test("Relay offer removes accidental LAN shortcuts without altering security attributes", () => {
  const result = relayOffer(answer);
  assert.match(result, /m=application 9 UDP\/DTLS\/SCTP/);
  assert.match(result, /192\.0\.2\.1 9 typ/);
  assert.equal(
    result.split("\r\n").filter((line) => line.startsWith("a=candidate:"))
      .length,
    1,
  );
  for (const line of protectedLines) assert(result.includes(line + "\r\n"));
  assert.equal(relayOffer("error-code"), "error-code");
});

test("Only complete STUN binding requests with a bounded username can allocate a relay", () => {
  const username = Buffer.from("server123:client456");
  const padded = (username.length + 3) & ~3;
  const packet = Buffer.alloc(24 + padded);
  packet.writeUInt16BE(1, 0);
  packet.writeUInt16BE(4 + padded, 2);
  packet.writeUInt32BE(0x2112a442, 4);
  packet.writeUInt16BE(6, 20);
  packet.writeUInt16BE(username.length, 22);
  username.copy(packet, 24);
  assert.equal(stunUsername(packet), username.toString());
  assert.equal(stunUsername(packet.subarray(0, packet.length - 1)), "");
  const response = Buffer.from(packet);
  response.writeUInt16BE(0x101, 0);
  assert.equal(stunUsername(response), "");
  const wrongCookie = Buffer.from(packet);
  wrongCookie.writeUInt32BE(0, 4);
  assert.equal(stunUsername(wrongCookie), "");
  const overflow = Buffer.from(packet);
  overflow.writeUInt16BE(65535, 22);
  assert.equal(stunUsername(overflow), "");
  assert.equal(stunUsername(Buffer.from([22, 254, 255])), "");
});

test("Direct config rejects wildcard domains, injected ports, secrets and unexpected settings", () => {
  const valid = {
    version: 1,
    enabled: true,
    name: "IPv6",
    domain: "home.example.com",
    httpsPort: 8443,
    udpPort: 19139,
    upstreamPort: 19132,
    localIPv4: "192.168.1.144",
    localUdpPort: 19132,
    interfaceName: "WLAN",
    hostId: "38b",
    controlToken: "a".repeat(64),
  };
  assert(directConfigSchema.safeParse(valid).success);
  for (const change of [
    { domain: "*.example.com" },
    { domain: "example.com/path" },
    { udpPort: 0 },
    { localIPv4: "evil.example.com" },
    { hostId: "::38b" },
    { password: "must-not-be-here" },
  ])
    assert(!directConfigSchema.safeParse({ ...valid, ...change }).success);
});

test("Desktop direct controls hide credentials, reject unknown instances and stop only the dedicated service", async () => {
  const tools = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-direct-"));
  const id = "161f35b0-3221-4ff2-adb0-d4ba5ad70a88";
  const root = path.join(tools, "direct", id);
  const token = "c".repeat(64);
  const value = {
    version: 1,
    enabled: true,
    name: "fixture",
    domain: "home.example.com",
    httpsPort: 8443,
    udpPort: 19139,
    upstreamPort: 19132,
    localIPv4: "192.168.1.144",
    localUdpPort: 19132,
    interfaceName: "fixture",
    hostId: "38b",
    controlToken: token,
  };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "route.json"), JSON.stringify(value));
  const requests: string[] = [];
  const server = net.createServer((socket) => {
    let text = "";
    socket.on("data", (data) => {
      text += data;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text);
      if (request.token !== token) {
        socket.end();
        return;
      }
      if (request.action === "stop") {
        socket.end('{"ok":true}\n');
        server.close();
      } else
        socket.end(
          JSON.stringify({
            running: true,
            ready: true,
            configured: true,
            publicIPv6: "2001:db8::38b",
          }) + "\n",
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlPipe(root), resolve);
  });
  const agent = {
    async call(method: string) {
      requests.push(method);
      return { instances: [{ id }] };
    },
  } as any;
  const manager = new DirectRoutes(
    agent,
    tools,
    process.execPath,
    "never-launch.cjs",
    "never-probe.exe",
    async () => ["2001:db8::38b"],
  );
  try {
    const state = await manager.get(id);
    assert.equal(state.ready, true);
    assert.equal(state.ddns?.ok, true);
    assert(!JSON.stringify(state).includes(token));
    const configFile = path.join(root, "route.json");
    const oldTime = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(configFile, oldTime, oldTime);
    const beforeRestore = await fs.stat(configFile);
    await manager.action(id, "start");
    await manager.restore();
    assert.equal(
      (await fs.stat(configFile)).mtimeMs,
      beforeRestore.mtimeMs,
      "opening the desktop must not rewrite a live enabled route",
    );
    await assert.rejects(directControl(root, "d".repeat(64)));
    await assert.rejects(manager.get("../../outside"), /实例不存在/);
    const stopped = await manager.action(id, "stop");
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.running, false);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, "route.json"), "utf8"))
        .enabled,
      false,
    );
    assert(
      requests.every((method) => method === "bootstrap"),
      "direct controls must never stop a game server or tunnel",
    );
  } finally {
    server.close();
    await fs.rm(tools, { recursive: true, force: true });
  }
});
