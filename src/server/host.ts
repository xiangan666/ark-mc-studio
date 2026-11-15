/** Own game stdio independently of both the desktop and replaceable management service. */
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { serverHostPipe } from "./control";

async function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(args[args.indexOf("--root") + 1]);
  const config = JSON.parse(
    await fs.readFile(path.join(root, "launch.json"), "utf8"),
  );
  if (
    !/^[a-f0-9]{64}$/.test(config.token) ||
    !path.isAbsolute(config.root) ||
    !path.isAbsolute(config.executable) ||
    !Array.isArray(config.args) ||
    config.args.some(
      (a: unknown) => typeof a !== "string" || a.length > 4096,
    ) ||
    !path.isAbsolute(config.log)
  )
    throw new Error("会话宿主启动配置无效");
  const lockFile = path.join(root, "host.lock");
  let lock: fs.FileHandle;
  try {
    lock = await fs.open(lockFile, "wx");
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const previous = JSON.parse(await fs.readFile(lockFile, "utf8"));
    try {
      process.kill(previous.pid, 0);
      throw new Error("会话宿主已运行，拒绝重复启动");
    } catch (e: any) {
      if (e.code !== "ESRCH") throw e;
    }
    await fs.unlink(lockFile);
    lock = await fs.open(lockFile, "wx");
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await lock.close();
  let lastError: string | undefined;
  const output = createWriteStream(config.log, { flags: "a" });
  output.on("error", () => {
    lastError = "服务器日志暂无法写入，请检查磁盘空间与权限";
    child.stdout?.resume();
    child.stderr?.resume();
  });
  const env = { ...process.env };
  for (const [name, value] of Object.entries(config.env || {})) {
    if (value === null) delete env[name];
    else if (typeof value === "string") env[name] = value;
    else throw new Error("会话宿主环境配置无效");
  }
  const child = spawn(config.executable, config.args, {
    cwd: config.root,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.stdout!.pipe(output, { end: false });
  child.stderr!.pipe(output, { end: false });
  child.stdin!.on("error", () => {
    lastError = "游戏控制台输入通道已关闭";
  });
  let running = true;
  const startedAt = Date.now();
  const status = () => ({
    hostPid: process.pid,
    childPid: child.pid!,
    root: config.root,
    startedAt,
    running,
    error: lastError,
  });
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => {});
    let text = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      text += chunk.toString();
      if (text.length > 8192) return socket.destroy();
      if (!text.includes("\n")) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(text.split("\n")[0]);
          const incoming = Buffer.from(String(request.token || "")),
            expected = Buffer.from(config.token);
          if (
            incoming.length !== expected.length ||
            !timingSafeEqual(incoming, expected)
          )
            throw new Error("会话连接验证失败");
          if (request.method === "command") {
            if (
              !running ||
              typeof request.command !== "string" ||
              !request.command ||
              request.command.length > 2048 ||
              /[\r\n\0]/.test(request.command)
            )
              throw new Error("无效的控制台命令");
            await new Promise<void>((resolve, reject) =>
              child.stdin!.write(request.command + "\n", (e) =>
                e ? reject(e) : resolve(),
              ),
            );
          } else if (request.method !== "status")
            throw new Error("不支持的会话操作");
          socket.end(JSON.stringify({ ok: true, data: status() }) + "\n");
        } catch (error: any) {
          socket.end(
            JSON.stringify({ ok: false, error: error.message }) + "\n",
          );
        }
      })();
    });
  });
  // Wait for stdio to close before ending the log, preserving the final save output.
  child.once("close", (code) => {
    running = false;
    const receipt = fs
      .writeFile(
        path.join(root, "exit.json"),
        JSON.stringify({ code, at: Date.now(), childPid: child.pid }),
      )
      .catch(() => {});
    output.end(() => {
      void receipt.finally(() => {
        for (const socket of clients) socket.destroy();
        server.close();
        void fs
          .unlink(lockFile)
          .catch(() => {})
          .finally(() => process.exit(0));
      });
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(serverHostPipe(root), resolve);
  });
  const file = path.join(root, "host.json");
  await fs.writeFile(
    file + ".tmp",
    JSON.stringify({ token: config.token, ...status() }),
  );
  await fs.rename(file + ".tmp", file);
}
void main().catch(() => {
  process.stderr.write("服务器会话宿主启动失败，请检查配置及运行日志\n");
  process.exit(1);
});
