import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";

export interface ServerHostStatus {
  hostPid: number;
  childPid: number;
  root: string;
  startedAt: number;
  running: boolean;
  error?: string;
}
export const serverHostPipe = (root: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\arkmc-server-${createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 24)}`
    : path.join(root, "control.sock");

export async function serverHostControl(
  root: string,
  command?: string,
): Promise<ServerHostStatus> {
  const auth = JSON.parse(
    await fs.readFile(path.join(root, "host.json"), "utf8"),
  );
  if (!/^[a-f0-9]{64}$/.test(auth.token)) throw new Error("会话宿主凭证无效");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(serverHostPipe(root));
    let response = "";
    const finish = (error?: Error, value?: ServerHostStatus) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("会话宿主响应超时")), 3000);
    socket.once("error", finish);
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          token: auth.token,
          method: command === undefined ? "status" : "command",
          command,
        }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.length > 16384) return finish(new Error("会话宿主响应过大"));
      if (!response.includes("\n")) return;
      try {
        const value = JSON.parse(response.split("\n")[0]);
        if (!value.ok)
          return finish(new Error(value.error || "会话宿主拒绝请求"));
        if (
          value.data.hostPid !== auth.hostPid ||
          value.data.childPid !== auth.childPid ||
          value.data.root !== auth.root
        )
          return finish(new Error("会话宿主身份已变化"));
        finish(undefined, value.data);
      } catch {
        finish(new Error("会话宿主响应无效"));
      }
    });
    socket.once("end", () => {
      if (!response.includes("\n")) finish(new Error("会话宿主连接已关闭"));
    });
  });
}
