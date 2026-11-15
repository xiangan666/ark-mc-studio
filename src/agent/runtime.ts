import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { serverHostControl, type ServerHostStatus } from "../server/control";
import { EventEmitter } from "node:events";
import type {
  AgentEvent,
  Instance,
  LogLine,
  Metric,
  Player,
  ProcessInfo,
  Snapshot,
  Status,
} from "../shared/types";
import { Store } from "./store";
import {
  exists,
  json,
  tail,
  properties,
  sleep,
  redact,
  errorText,
  atomicWrite,
} from "./safe";

export function runFile(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      executable,
      args,
      {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: options.timeout || 120000,
        ...options,
      },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(redact(`${error.message}\n${stderr}`).slice(0, 3500)),
            )
          : resolve(stdout),
    ),
  );
}
export function ps(script: string, args: string[] = [], timeout = 120000) {
  return runFile(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args,
    ],
    { timeout },
  );
}
export class Runtime extends EventEmitter {
  processes: ProcessInfo[] = [];
  samplerReady = false;
  get telemetryFresh() {
    return this.samplerReady && Date.now() - this.sampleAt < 15000;
  }
  snapshots = new Map<string, Snapshot>();
  logLines = new Map<string, LogLine[]>();
  private offsets = new Map<string, number>();
  private carries = new Map<string, string>();
  private seq = 0;
  private previous = new Map<
    number,
    { cpu: number; at: number; value: number | null }
  >();
  private sampleAt = 0;
  private states = new Map<string, Status>();
  private children = new Map<string, ChildProcess>();
  private commandQueues = new Map<string, Promise<unknown>>();
  private pollBusy = false;
  private sampler?: ChildProcess;
  private timer?: ReturnType<typeof setInterval>;
  private tps = new Map<string, { at: number; tps: number; mspt: number }>();
  private activePlayers = new Map<string, Set<string>>();
  private lastProbe = new Map<string, number>();
  private maintenance = new Set<string>();
  private errors = new Map<string, string>();
  constructor(
    public store: Store,
    private emitEvent: (event: AgentEvent) => void,
    private resources: string,
  ) {
    super();
  }
  async init() {
    for (const i of this.store.instances()) await this.pollLog(i);
    if (process.platform === "win32") {
      this.sampler = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(this.resources, "telemetry.ps1"),
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const rl = readline.createInterface({ input: this.sampler.stdout! });
      rl.on("line", (line) => {
        try {
          const data = JSON.parse(line);
          if (data.processes) {
            this.processes = data.processes;
            this.sampleAt = Number(data.at) || Date.now();
            this.samplerReady = true;
            void this.refresh();
          }
        } catch {}
      });
      this.sampler.on("error", (e) => this.errors.set("sampler", errorText(e)));
      this.sampler.stderr?.on("data", () => {});
    }
    this.timer = setInterval(() => {
      void this.refresh();
    }, 2000);
    await this.refresh();
  }
  async refresh() {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      for (const instance of this.store.instances()) {
        await this.pollLog(instance);
        await this.snapshot(instance);
      }
    } catch (error) {
      this.errors.set("refresh", errorText(error));
    } finally {
      this.pollBusy = false;
    }
  }
  async discover() {
    if (this.store.instances().length) return;
    const base = path.join(os.homedir(), "Documents", "bedrock");
    const root = path.join(base, "bedrock-server-1.26.60.6-local");
    if (await exists(path.join(root, "server.properties")))
      await this.import(root, path.join(base, "mc-tunnel-lolia"));
  }
  async import(root: string, tunnelRoot?: string) {
    root = await fs.realpath(root);
    if (
      this.store
        .instances()
        .some((i) => i.root.toLowerCase() === root.toLowerCase())
    )
      throw new Error("这个目录已经添加");
    if (
      this.store
        .instances()
        .some(
          (i) =>
            root.toLowerCase().startsWith(i.root.toLowerCase() + path.sep) ||
            i.root.toLowerCase().startsWith(root.toLowerCase() + path.sep),
        )
    )
      throw new Error("实例目录不能相互嵌套");
    if (!(await exists(path.join(root, "server.properties"))))
      throw new Error("请选择包含 server.properties 的服务器目录");
    if (!(await exists(path.join(root, "bedrock_server.exe"))))
      throw new Error("目录中没有 Windows 基岩版服务端");
    const config = properties(
      await fs.readFile(path.join(root, "server.properties"), "utf8"),
    );
    let recorded: Instance | undefined;
    const toolRoot = this.store.get<string | null>("managed-tools-root", null);
    if (toolRoot) {
      for (const entry of await fs
        .readdir(path.join(toolRoot, "instances"), { withFileTypes: true })
        .catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const item = await json<Instance | null>(
          path.join(toolRoot, "instances", entry.name, "instance.json"),
          null,
        );
        if (item?.root.toLowerCase() === root.toLowerCase()) {
          recorded = item;
          break;
        }
      }
    }
    const python =
      recorded?.python || path.join(root, ".venv", "Scripts", "python.exe");
    const endstone = await exists(python);
    const network =
      tunnelRoot && (await exists(tunnelRoot))
        ? tunnelRoot
        : recorded?.tunnelRoot;
    const instance: Instance = {
      id: recorded?.id || randomUUID(),
      name: config["server-name"] || path.basename(root),
      root,
      core: recorded?.core || (endstone ? "endstone" : "bds"),
      preferredCore: recorded?.preferredCore,
      adapter: (await exists(path.join(root, "run-server.py")))
        ? "legacy"
        : "managed",
      python: endstone ? python : undefined,
      tunnelRoot:
        network && (await exists(network))
          ? await fs.realpath(network)
          : undefined,
      endpointPath: recorded?.endpointPath,
      createdAt: recorded?.createdAt || Date.now(),
      version: recorded?.version,
    };
    this.store.put("instances", instance);
    this.activity(instance.id, `已关联服务器：${instance.name}`);
    await this.pollLog(instance);
    await this.snapshot(instance);
    return instance;
  }
  async saveInstance(instance: Instance) {
    const toolRoot = this.store.get<string | null>("managed-tools-root", null);
    if (toolRoot)
      await atomicWrite(
        path.join(toolRoot, "instances", instance.id, "instance.json"),
        JSON.stringify(instance, null, 2),
      );
    this.store.put("instances", instance);
  }
  activity(id: string | null, text: string, level = "info") {
    const item = this.store.activity(id, redact(text), level);
    this.emitEvent({ type: "activity", data: item });
    return item;
  }
  setMaintenance(id: string, on: boolean) {
    if (on) this.maintenance.add(id);
    else this.maintenance.delete(id);
  }
  private logFile(i: Instance) {
    return path.join(
      i.root,
      "logs",
      i.adapter === "legacy" ? "server.log" : "arkmc-server.log",
    );
  }
  async pollLog(i: Instance) {
    const file = this.logFile(i);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return;
    const offset = this.offsets.get(i.id);
    if (offset === undefined || stat.size < offset) {
      const data = await tail(file);
      this.offsets.set(i.id, data.size);
      this.logLines.set(i.id, []);
      this.activePlayers.set(i.id, new Set());
      this.ingest(i, data.text, true, stat.mtimeMs);
      return;
    }
    if (stat.size === offset) return;
    const handle = await fs.open(file, "r");
    try {
      const length = Math.min(stat.size - offset, 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const read = await handle.read(buffer, 0, length, offset);
      this.offsets.set(i.id, offset + read.bytesRead);
      this.ingest(
        i,
        buffer.subarray(0, read.bytesRead).toString("utf8"),
        false,
        stat.mtimeMs,
      );
    } finally {
      await handle.close();
    }
  }
  ingest(i: Instance, text: string, historical = false, mtime = Date.now()) {
    const full = (this.carries.get(i.id) || "") + text;
    const raw = full.split(/\r?\n/);
    this.carries.set(i.id, raw.pop() || "");
    const lines: LogLine[] = [];
    let date = new Date(mtime);
    let lastHour = 24;
    for (const rawLine of raw) {
      const clean = redact(rawLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
      if (!clean.trim()) continue;
      let at = Date.now();
      const clock = clean.match(/\[(\d{2}):(\d{2}):(\d{2})/);
      if (clock) {
        if (historical && +clock[1] > lastHour + 12)
          date = new Date(date.getTime() - 86400000);
        const d = new Date(date);
        d.setHours(+clock[1], +clock[2], +clock[3], 0);
        at = d.getTime();
        lastHour = +clock[1];
      }
      const level: LogLine["level"] = /\b(ERROR|FATAL|CRITICAL)\b/.test(clean)
        ? "ERROR"
        : /\bWARN(?:ING)?\b/.test(clean)
          ? "WARN"
          : /\bDEBUG\b/.test(clean)
            ? "DEBUG"
            : "INFO";
      const line = { seq: ++this.seq, at, level, text: clean };
      lines.push(line);
      if (/Server started\.?/.test(clean)) {
        this.activePlayers.set(i.id, new Set());
        for (const player of this.store.players(i.id)) {
          if (player.online && at > player.lastSeen)
            this.store.savePlayer(i.id, {
              ...player,
              online: false,
              joinedAt: undefined,
              lastSeen: at,
            });
        }
      }
      const tps = clean.match(/Current TPS:\s*([\d.]+).*MSPT:\s*([\d.]+)/);
      if (tps) this.tps.set(i.id, { at, tps: +tps[1], mspt: +tps[2] });
      const connected = clean.match(
        /Player connected:\s*(.+?),\s*xuid:\s*(\d+)/,
      );
      const joined = clean.match(/\]:\s*(.+) joined the game$/);
      const left =
        clean.match(/Player disconnected:\s*(.+?),\s*xuid:\s*(\d+)/) ||
        clean.match(/\]:\s*(.+) left the game$/);
      const names = this.activePlayers.get(i.id) || new Set<string>();
      this.activePlayers.set(i.id, names);
      if (connected) {
        const old = this.store
          .players(i.id)
          .find((p) => p.name === connected[1]);
        if (!historical || !old || at > old.lastSeen)
          this.store.savePlayer(i.id, {
            name: connected[1],
            xuid: connected[2],
            online: i.core === "bds",
            joinedAt: i.core === "bds" ? at : undefined,
            totalSeconds: old?.totalSeconds || 0,
            lastSeen: at,
          });
      }
      if (joined && !names.has(joined[1])) {
        names.add(joined[1]);
        const old = this.store.players(i.id).find((p) => p.name === joined[1]);
        if (!historical || !old || at > old.lastSeen)
          this.store.savePlayer(i.id, {
            ...old,
            name: joined[1],
            online: true,
            joinedAt: at,
            totalSeconds: old?.totalSeconds || 0,
            lastSeen: at,
          });
        if (!historical) this.activity(i.id, `${joined[1]} 加入了世界`);
      }
      if (left) {
        const name = left[1];
        const old = this.store.players(i.id).find((p) => p.name === name);
        names.delete(name);
        if (old && (!historical || at > old.lastSeen))
          this.store.savePlayer(i.id, {
            ...old,
            online: false,
            joinedAt: undefined,
            totalSeconds:
              old.totalSeconds +
              (old.online && old.joinedAt
                ? Math.max(0, (at - old.joinedAt) / 1000)
                : 0),
            lastSeen: at,
          });
        if (!historical && old?.online)
          this.activity(i.id, `${name} 离开了世界`);
      }
      this.emit(`line:${i.id}`, line);
    }
    const all = [...(this.logLines.get(i.id) || []), ...lines].slice(-6000);
    this.logLines.set(i.id, all);
    if (lines.length)
      this.emitEvent({
        type: "logs",
        instanceId: i.id,
        data: historical ? lines.slice(-1000) : lines,
      });
  }
  private async legacyState(i: Instance) {
    const state = await json<any>(
      path.join(i.root, ".server-state.json"),
      null,
    );
    if (!state) return null;
    const p = this.processes.find((p) => p.pid === state.supervisorPid);
    if (
      p &&
      p.name.toLowerCase() === "python.exe" &&
      p.command
        ?.toLowerCase()
        .includes(path.join(i.root, "run-server.py").toLowerCase()) &&
      Math.abs(p.createdAt - state.startedAt * 1000) < 15000
    )
      return state;
    return null;
  }
  private hostRoot(id: string) {
    return path.join(this.store.root, "server-hosts", id);
  }
  private async sessionHost(
    i: Instance,
    game?: ProcessInfo,
  ): Promise<ServerHostStatus | null> {
    if (i.adapter !== "managed") return null;
    const root = this.hostRoot(i.id);
    const host = await serverHostControl(root).catch(() => null);
    if (
      !host?.running ||
      path.resolve(host.root).toLowerCase() !==
        path.resolve(i.root).toLowerCase()
    )
      return null;
    const process = this.processes.find((p) => p.pid === host.hostPid);
    if (
      !process ||
      !/^node(?:\.exe)?$/i.test(process.name) ||
      !process.command?.toLowerCase().includes(root.toLowerCase()) ||
      Math.abs(process.createdAt - host.startedAt) > 30000
    )
      return null;
    const child = this.processes.find((p) => p.pid === host.childPid);
    if (
      !child ||
      child.ppid !== host.hostPid ||
      Math.abs(child.createdAt - host.startedAt) > 30000
    )
      return null;
    let current = game;
    for (let n = 0; current && n < 10; n++) {
      if (current.pid === host.childPid) return host;
      current = this.processes.find((p) => p.pid === current!.ppid);
    }
    return null;
  }
  async snapshot(i: Instance, record = true): Promise<Snapshot> {
    const props = properties(
      await fs
        .readFile(path.join(i.root, "server.properties"), "utf8")
        .catch(() => ""),
    );
    const exe = path.join(i.root, "bedrock_server.exe").toLowerCase();
    const processInfo = this.processes.find(
      (p) => p.path?.toLowerCase() === exe,
    );
    const state = i.adapter === "legacy" ? await this.legacyState(i) : null;
    const host = await this.sessionHost(i, processInfo);
    if (host?.error) this.errors.set(i.id, host.error);
    if (!processInfo && i.adapter === "managed" && !this.states.has(i.id)) {
      const exit = await json<{ code: number | null } | null>(
        path.join(this.hostRoot(i.id), "exit.json"),
        null,
      );
      if (exit?.code) this.errors.set(i.id, `服务端退出，代码 ${exit.code}`);
    }
    const controlled = !!state || !!host || !!this.children.get(i.id);
    let status: Status = this.states.get(i.id) || "stopped";
    if (processInfo) {
      if (!["starting", "stopping"].includes(status))
        status = controlled ? "running" : "unmanaged";
    } else if (!["starting", "stopping"].includes(status))
      status = this.samplerReady ? "stopped" : "unknown";
    const now = Date.now();
    let cpu: number | null = null;
    if (processInfo) {
      const prev = this.previous.get(processInfo.pid);
      const sampleAt = this.sampleAt || now;
      if (prev && sampleAt === prev.at) cpu = prev.value;
      else if (prev && sampleAt > prev.at)
        cpu = Math.min(
          100,
          Math.max(
            0,
            (((processInfo.cpuTime - prev.cpu) / (sampleAt - prev.at)) *
              100000) /
              os.cpus().length,
          ),
        );
      if (!prev || sampleAt !== prev.at)
        this.previous.set(processInfo.pid, {
          cpu: processInfo.cpuTime,
          at: sampleAt,
          value: cpu,
        });
    }
    const tick = this.tps.get(i.id);
    const players = this.store
      .players(i.id)
      .map((p) => ({ ...p, online: !!processInfo && p.online }));
    const metric: Metric = {
      at: now,
      cpu,
      memory: processInfo?.memory ?? null,
      tps: tick && now - tick.at < 60000 && processInfo ? tick.tps : null,
      mspt: tick && now - tick.at < 60000 && processInfo ? tick.mspt : null,
      players: processInfo
        ? players.filter((p) => p.online).length
        : status === "stopped"
          ? 0
          : null,
    };
    const logs = (this.logLines.get(i.id) || []).map((l) => l.text).join("\n");
    const version =
      [...logs.matchAll(/Version:\s*(\d[\d.]+)/g)].at(-1)?.[1] ||
      (await fs
        .readFile(path.join(i.root, ".ark-install.json"), "utf8")
        .then((t) => JSON.parse(t).version)
        .catch(() => "")) ||
      (
        await fs
          .readFile(path.join(i.root, "version.txt"), "utf8")
          .catch(() => "")
      ).trim() ||
      i.version ||
      "未识别";
    const pythonVersionFile = path.join(
      i.python
        ? path.dirname(path.dirname(i.python))
        : path.join(i.root, ".venv"),
      "Lib",
      "site-packages",
      "endstone",
      "_version.py",
    );
    const endstoneVersion =
      i.core === "endstone"
        ? (await fs.readFile(pythonVersionFile, "utf8").catch(() => "")).match(
            /__version__\s*=\s*version\s*=\s*['"]([^'"]+)/,
          )?.[1] || "已安装"
        : "";
    const snapshot: Snapshot = {
      id: i.id,
      status,
      pid: processInfo?.pid || null,
      startedAt: state?.startedAt * 1000 || processInfo?.createdAt || null,
      world: props["level-name"] || "Bedrock level",
      port: +props["server-port"] || 19132,
      transport: props.transport || "raknet",
      maxPlayers: +props["max-players"] || 10,
      version,
      endstoneVersion,
      metric,
      players,
      capabilities: {
        command: controlled,
        tps: i.core === "endstone",
        managed: controlled,
        sessionHost: !!host || !!state,
      },
      lastError: this.errors.get(i.id),
    };
    this.snapshots.set(i.id, snapshot);
    if (record) {
      this.store.metric(i.id, metric);
      this.emitEvent({ type: "snapshot", instanceId: i.id, data: snapshot });
    }
    if (
      status === "running" &&
      !this.maintenance.has(i.id) &&
      now - (this.lastProbe.get(i.id) || 0) > 15000
    ) {
      this.lastProbe.set(i.id, now);
      void this.command(
        i.id,
        i.core === "endstone" ? "status" : "list",
        false,
      ).catch(() => {});
    }
    return snapshot;
  }
  async get(id: string) {
    return (
      this.snapshots.get(id) || this.snapshot(this.store.instance(id), false)
    );
  }
  logs(id: string, after = 0) {
    return (this.logLines.get(id) || [])
      .filter((l) => l.seq > after)
      .slice(-2000);
  }
  async command(id: string, command: string, audit = true): Promise<void> {
    if (!command || command.length > 2048 || /[\r\n\0]/.test(command))
      throw new Error("请输入一条有效的控制台命令");
    const previous = this.commandQueues.get(id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const i = this.store.instance(id);
        const child = this.children.get(id);
        if (i.adapter === "legacy") {
          if (!(await this.legacyState(i)))
            throw new Error("守护进程身份校验未通过，无法发送命令");
          const pending = path.join(i.root, ".console-command.json");
          const temp = path.join(i.root, `.ark-command-${randomUUID()}.tmp`);
          await fs.writeFile(temp, JSON.stringify({ command }), "utf8");
          try {
            let sent = false;
            for (let n = 0; n < 100; n++) {
              try {
                await fs.link(temp, pending);
                sent = true;
                break;
              } catch (e: any) {
                if (e.code !== "EEXIST") throw e;
                await sleep(100);
              }
            }
            if (!sent) throw new Error("控制台忙，请检查待处理命令");
            for (let n = 0; n < 100; n++) {
              if (!(await exists(pending))) break;
              await sleep(100);
              if (n === 99) throw new Error("守护进程没有读取控制台命令");
            }
          } finally {
            await fs.rm(temp, { force: true });
          }
        } else {
          if (child?.stdin?.writable) {
            await new Promise<void>((resolve, reject) =>
              child.stdin!.write(command + "\n", (error) =>
                error ? reject(error) : resolve(),
              ),
            );
          } else {
            const game = this.processes.find(
              (p) =>
                p.path?.toLowerCase() ===
                path.join(i.root, "bedrock_server.exe").toLowerCase(),
            );
            if (!(await this.sessionHost(i, game)))
              throw new Error("未找到身份匹配的独立会话宿主，暂不能发送命令");
            await serverHostControl(this.hostRoot(id), command);
          }
        }
        if (audit) this.activity(id, `控制台命令：${command}`);
      });
    this.commandQueues.set(id, next);
    await next;
  }
  async start(id: string, signal?: AbortSignal) {
    const i = this.store.instance(id);
    const state = await this.get(id);
    if (state.pid || ["starting", "stopping"].includes(state.status))
      throw new Error("服务器已经运行或正在切换状态");
    if (!this.samplerReady) throw new Error("正在识别进程，请稍后重试");
    this.states.set(id, "starting");
    await this.snapshot(i, false);
    this.errors.delete(id);
    const startSeq = this.logLines.get(id)?.at(-1)?.seq || 0;
    try {
      if (i.adapter === "legacy")
        await ps(path.join(i.root, "Start-Server.ps1"));
      else {
        const env = {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
        };
        delete (env as any).SERVER_IP;
        delete (env as any).SERVER_PORT;
        const endpoint = await json<any>(
          i.endpointPath || path.join(i.root, "tunnel-endpoint.json"),
          {},
        );
        if (endpoint.mode === "lolia") {
          (env as any).SERVER_IP = endpoint.publicUdpIP;
          (env as any).SERVER_PORT = String(endpoint.publicUdpPort);
        }
        const executable =
          i.core === "endstone"
            ? i.python!
            : path.join(i.root, "bedrock_server.exe");
        const args =
          i.core === "endstone"
            ? [
                "-m",
                "endstone",
                "--yes",
                "--server-folder",
                i.root,
                "--no-interactive",
              ]
            : [];
        await fs.mkdir(path.join(i.root, "logs"), { recursive: true });
        const hostRoot = this.hostRoot(id);
        const existing = await serverHostControl(hostRoot).catch(() => null);
        if (existing?.running)
          throw new Error("独立会话宿主已持有此实例，请等待进程采样完成");
        await fs.mkdir(hostRoot, { recursive: true });
        await fs.rm(path.join(hostRoot, "exit.json"), { force: true });
        const hostBundle = (await exists(
          path.join(this.resources, "server", "host.cjs"),
        ))
          ? path.join(this.resources, "server", "host.cjs")
          : path.resolve(this.resources, "../dist-server/host.cjs");
        if (!(await exists(hostBundle)))
          throw new Error("独立会话宿主资源缺失，请重新安装完整便携程序");
        await atomicWrite(
          path.join(hostRoot, "launch.json"),
          JSON.stringify({
            token: randomBytes(32).toString("hex"),
            root: i.root,
            executable,
            args,
            log: this.logFile(i),
            env: {
              PYTHONUNBUFFERED: "1",
              PYTHONIOENCODING: "utf-8",
              SERVER_IP: (env as any).SERVER_IP ?? null,
              SERVER_PORT: (env as any).SERVER_PORT ?? null,
            },
          }),
        );
        const out = await fs.open(path.join(hostRoot, "host.log"), "a");
        try {
          const host = spawn(
            process.execPath,
            [hostBundle, "--root", hostRoot],
            {
              detached: true,
              windowsHide: true,
              stdio: ["ignore", out.fd, out.fd],
              env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
            },
          );
          await new Promise<void>((resolve, reject) => {
            host.once("spawn", resolve);
            host.once("error", reject);
          });
          host.unref();
        } finally {
          await out.close();
        }
      }
      for (let n = 0; n < 90; n++) {
        signal?.throwIfAborted();
        await sleep(1000, signal);
        await this.refresh();
        if (
          this.snapshots.get(id)?.pid &&
          this.logs(id, startSeq).some((line) =>
            /Server started\.?/i.test(line.text),
          )
        ) {
          this.states.delete(id);
          this.activity(id, "服务器已启动");
          return true;
        }
        if (this.errors.has(id)) throw new Error(this.errors.get(id));
      }
      throw new Error("启动等待超时，请查看服务端日志");
    } catch (error) {
      this.errors.set(id, errorText(error));
      throw error;
    } finally {
      this.states.delete(id);
      await this.snapshot(i, false);
    }
  }
  async stop(id: string) {
    const i = this.store.instance(id);
    const snap = await this.get(id);
    if (!snap.pid) return true;
    if (!snap.capabilities.command)
      throw new Error(
        "当前进程无法安全接管控制台，请通过原启动窗口正常停止后再由本程序启动",
      );
    this.states.set(id, "stopping");
    this.setMaintenance(id, true);
    try {
      await this.command(id, "stop");
      for (let n = 0; n < 100; n++) {
        await sleep(1000);
        await this.refresh();
        if (!this.processes.some((p) => p.pid === snap.pid)) {
          if (
            i.adapter === "managed" &&
            (await serverHostControl(this.hostRoot(id)).catch(() => null))
              ?.running
          )
            continue;
          this.activity(id, "服务器已正常保存并关闭");
          return true;
        }
      }
      throw new Error("服务器仍在保存，未强制结束；请检查日志");
    } finally {
      this.states.delete(id);
      this.setMaintenance(id, false);
      await this.snapshot(i, false);
    }
  }
  async restart(id: string, signal?: AbortSignal, countdown = 0) {
    if ((await this.get(id)).pid && countdown > 0) {
      for (let left = countdown; left > 0; left--) {
        signal?.throwIfAborted();
        if ([60, 30, 10, 5, 4, 3, 2, 1].includes(left) || left === countdown)
          await this.command(id, `say 服务器将在 ${left} 秒后重启，请做好准备`);
        await sleep(1000, signal);
      }
    }
    await this.stop(id);
    return this.start(id, signal);
  }
  async waitLines(
    id: string,
    command: string,
    accept: (text: string) => boolean,
    timeout = 12000,
  ) {
    let output = "";
    let listener: (line: LogLine) => void = () => {};
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(`line:${id}`, listener);
        reject(new Error("服务器响应超时"));
      }, timeout);
      listener = (line) => {
        output += line.text + "\n";
        if (accept(output)) {
          clearTimeout(timer);
          this.off(`line:${id}`, listener);
          resolve(output);
        }
      };
      this.on(`line:${id}`, listener);
    });
    try {
      await this.command(id, command, false);
      return await ready;
    } catch (error) {
      this.off(`line:${id}`, listener);
      void ready.catch(() => {});
      throw error;
    }
  }
  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.sampler?.kill();
  }
}
