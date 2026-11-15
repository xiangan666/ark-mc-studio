import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AgentEvent } from "../shared/types";
import { Store, defaultDataRoot } from "./store";
import { API } from "./api";
import { atomicWrite, digest, errorText, json } from "./safe";
import { version as programVersion } from "../../package.json";
import { backendReloadBlock } from "../shared/backend";

async function main() {
  const args = process.argv.slice(2);
  const option = (key: string) => args[args.indexOf(key) + 1];
  const root = args.includes("--data") ? option("--data") : defaultDataRoot();
  const toolsRoot = args.includes("--tools") ? option("--tools") : undefined;
  const resources = args.includes("--resources")
    ? option("--resources")
    : path.resolve(__dirname, "../resources");
  await fs.mkdir(root, { recursive: true });
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\arkmc-${digest(root).slice(0, 16)}`
      : path.join(root, "agent.sock");
  const authFile = path.join(root, ".agent-auth.json");
  const previous = await json<any>(authFile, null);
  const token = previous?.token || randomBytes(32).toString("hex");
  await atomicWrite(
    authFile,
    JSON.stringify({ token, pipe, pid: process.pid }),
  );
  const clients = new Set<net.Socket>();
  const emit = (event: AgentEvent) => {
    const data = JSON.stringify({ event }) + "\n";
    for (const client of clients) {
      if (client.writableLength > 8 * 1024 * 1024) {
        client.destroy();
        clients.delete(client);
      } else client.write(data);
    }
  };
  let api: API | undefined;
  let shuttingDown = false;
  const envelope = z.object({
    id: z.string().max(80),
    token: z.string().max(128),
    method: z.string().max(100),
    args: z.record(z.string(), z.unknown()).optional(),
  });
  const server = net.createServer((socket) => {
    let authenticated = false;
    const rl = readline.createInterface({ input: socket });
    let bytes = 0;
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) socket.destroy();
      setTimeout(() => {
        bytes = Math.max(0, bytes - chunk.length);
      }, 1000).unref();
    });
    rl.on("line", (line) => {
      void (async () => {
        let requestId = "";
        try {
          if (line.length > 4 * 1024 * 1024) throw new Error("请求内容过大");
          const request = envelope.parse(JSON.parse(line));
          requestId = request.id;
          const incoming = Buffer.from(request.token);
          const expected = Buffer.from(token);
          if (
            incoming.length !== expected.length ||
            !timingSafeEqual(incoming, expected)
          )
            throw new Error("本机管理连接验证失败");
          if (!authenticated) {
            clients.add(socket);
            authenticated = true;
          }
          if (!api) throw new Error("后台正在初始化，请稍后重试");
          if (shuttingDown) throw new Error("程序正在退出，请等待完成");
          if (request.method === "program.shutdown") {
            await api.runtime.refresh();
            const blocked = backendReloadBlock(
              await api.bootstrap(),
              request.args?.preserveSessions === true,
            );
            if (blocked) throw new Error(blocked);
            shuttingDown = true;
            socket.write(
              JSON.stringify({ id: request.id, ok: true, data: true }) + "\n",
              () => {
                for (const client of clients) client.destroy();
                server.close();
                api?.dispose();
                process.exit(0);
              },
            );
            return;
          }
          const data = await api.call(request.method, request.args || {});
          socket.write(
            JSON.stringify({ id: request.id, ok: true, data }) + "\n",
          );
        } catch (error) {
          socket.write(
            JSON.stringify({
              id: requestId,
              ok: false,
              error:
                error instanceof z.ZodError
                  ? "参数不符合要求：" +
                    error.issues.map((i) => i.message).join("；")
                  : errorText(error),
            }) + "\n",
          );
        }
      })();
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  api = new API(new Store(root), emit, resources, toolsRoot);
  await api.init(process.env.ARK_MC_NO_DISCOVER !== "1");
  const timer = setInterval(() => api!.store.prune(), 3600000);
  timer.unref();
  api.store.prune();
  await atomicWrite(
    path.join(root, ".agent-state.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      version: programVersion,
    }),
  );
  process.on("SIGTERM", () => {
    api?.dispose();
    server.close();
    process.exit(0);
  });
  process.on("uncaughtException", (error) => {
    void fs.appendFile(
      path.join(root, "agent-errors.log"),
      `${new Date().toISOString()} ${errorText(error)}\n`,
    );
  });
  process.on("unhandledRejection", (error) => {
    void fs.appendFile(
      path.join(root, "agent-errors.log"),
      `${new Date().toISOString()} ${errorText(error)}\n`,
    );
  });
}
void main().catch((error) => {
  console.error(errorText(error));
  process.exit(1);
});
