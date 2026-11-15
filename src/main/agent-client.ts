import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AgentEvent, Bootstrap } from "../shared/types";
import { backendReloadBlock } from "../shared/backend";
import { version as programVersion } from "../../package.json";

export class AgentClient extends EventEmitter {
  private socket?: net.Socket;
  private auth?: { token: string; pipe: string };
  private counter = 0;
  private pending = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private connecting?: Promise<void>;
  private reloading?: Promise<Bootstrap>;
  constructor(
    private root: string,
    private agent: string,
    private node: string,
    private resources: string,
    private toolsRoot?: string,
  ) {
    super();
  }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async open() {
    await fs.mkdir(this.root, { recursive: true });
    let launched = false;
    let last: unknown;
    for (let n = 0; n < 60; n++) {
      try {
        this.auth = JSON.parse(
          await fs.readFile(path.join(this.root, ".agent-auth.json"), "utf8"),
        );
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(this.auth!.pipe);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
          s.setTimeout(2000, () => s.destroy(new Error("后台连接超时")));
        });
        socket.setTimeout(0);
        this.socket = socket;
        const rl = readline.createInterface({ input: socket });
        rl.on("line", (line) => {
          try {
            const message = JSON.parse(line);
            if (message.event) this.emit("event", message.event as AgentEvent);
            else {
              const pending = this.pending.get(message.id);
              if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(message.id);
                message.ok
                  ? pending.resolve(message.data)
                  : pending.reject(new Error(message.error));
              }
            }
          } catch {}
        });
        socket.on("close", () => {
          if (this.socket !== socket) return;
          this.socket = undefined;
          for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error("后台连接中断，请重试"));
          }
          this.pending.clear();
          this.emit("disconnected");
        });
        socket.on("error", () => {});
        return;
      } catch (error) {
        last = error;
        if (!launched) {
          const out = await fs.open(path.join(this.root, "agent.log"), "a");
          try {
            const child = spawn(
              this.node,
              [
                this.agent,
                "--data",
                this.root,
                "--resources",
                this.resources,
                ...(this.toolsRoot ? ["--tools", this.toolsRoot] : []),
              ],
              {
                windowsHide: true,
                detached: true,
                stdio: ["ignore", out.fd, out.fd],
                env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
              },
            );
            child.once("error", (e) => this.emit("agent-error", e));
            child.unref();
          } finally {
            await out.close();
          }
          launched = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(
      `后台未能启动：${last instanceof Error ? last.message : "请查看 agent.log"}`,
    );
  }
  async call<T = unknown>(
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.reloading) throw new Error("管理后台正在重载，请稍后重试");
    await this.connect();
    return this.request<T>(method, args);
  }
  private request<T = unknown>(
    method: string,
    args: Record<string, unknown> = {},
    timeoutMs = 180000,
  ): Promise<T> {
    const id = String(++this.counter);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("后台操作响应超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(
        JSON.stringify({ id, token: this.auth!.token, method, args }) + "\n",
      );
    });
  }
  reloadWhenIdle() {
    if (this.reloading) return this.reloading;
    this.reloading = this.reload().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }
  reloadPreservingSessions() {
    if (this.reloading) return this.reloading;
    this.reloading = this.reload(true).finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }
  async stopWhenIdle() {
    if (this.reloading) throw new Error("正在更新服务，请等待完成");
    await this.stopIdleBackend();
    return true;
  }
  private async stopIdleBackend(preserveSessions = false) {
    await this.connect();
    const current = await this.request<Bootstrap>("bootstrap");
    const blocked = backendReloadBlock(current, preserveSessions);
    if (blocked) throw new Error(blocked);
    const state = JSON.parse(
      await fs.readFile(path.join(this.root, ".agent-state.json"), "utf8"),
    );
    const auth = JSON.parse(
      await fs.readFile(path.join(this.root, ".agent-auth.json"), "utf8"),
    );
    if (
      !Number.isSafeInteger(state.pid) ||
      state.pid <= 0 ||
      state.pid === process.pid ||
      state.pid !== auth.pid ||
      state.version !== current.agentVersion ||
      auth.token !== this.auth?.token ||
      auth.pipe !== this.auth?.pipe
    )
      throw new Error("后台进程身份已变化，请重新连接后重试");
    const latest = await this.request<Bootstrap>("bootstrap");
    const latestBlock = backendReloadBlock(latest, preserveSessions);
    if (latestBlock) throw new Error(latestBlock);
    const execute = promisify(execFile);
    // Keep Windows process termination off Electron's main thread; never kill the descendant tree.
    if (
      current.features?.gracefulShutdown ||
      current.agentVersion === programVersion
    ) {
      await this.request("program.shutdown", { preserveSessions }, 10000);
    } else if (process.platform === "win32")
      await execute("taskkill.exe", ["/PID", String(state.pid), "/F"], {
        windowsHide: true,
        timeout: 10000,
      });
    else process.kill(state.pid, "SIGTERM");
    let exited = false;
    const exitDeadline = Date.now() + 10000;
    while (Date.now() < exitDeadline) {
      try {
        if (process.platform === "win32") {
          const { stdout } = await execute(
            "tasklist.exe",
            ["/FI", `PID eq ${state.pid}`, "/FO", "CSV", "/NH"],
            { windowsHide: true, timeout: 5000 },
          );
          if (!new RegExp(`^"[^\\r\\n"]+","${state.pid}",`, "m").test(stdout)) {
            exited = true;
            break;
          }
        } else process.kill(state.pid, 0);
      } catch (error: any) {
        if (error.code !== "ESRCH") throw error;
        exited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!exited) throw new Error("旧后台尚未退出，请稍后重新连接");
    this.disconnect();
  }
  private async reload(preserveSessions = false) {
    await this.stopIdleBackend(preserveSessions);
    let last: unknown;
    for (let n = 0; n < 10; n++) {
      try {
        await this.open();
        return await this.request<Bootstrap>("bootstrap", {}, 5000);
      } catch (error) {
        last = error;
        this.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(
      `后台重载后未就绪：${last instanceof Error ? last.message : "请查看 agent.log"}`,
    );
  }
  disconnect() {
    this.socket?.destroy();
    this.socket = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("后台连接中断，请重试"));
    }
    this.pending.clear();
  }
}
