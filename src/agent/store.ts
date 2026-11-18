import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { jobWindow } from "../shared/job-window";
import type {
  Instance,
  Metric,
  Settings,
  Activity,
  Job,
  Schedule,
  Backup,
  Player,
} from "../shared/types";

type Table = "instances" | "jobs" | "schedules" | "backups" | "players";
export class Store {
  db: DatabaseSync;
  constructor(public root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, "arkmc.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY,instanceId TEXT,at INTEGER,level TEXT,text TEXT); CREATE TABLE IF NOT EXISTS metrics (instanceId TEXT,at INTEGER,cpu REAL,memory REAL,tps REAL,mspt REAL,players INTEGER); CREATE INDEX IF NOT EXISTS metrics_instance_time ON metrics(instanceId,at);",
    );
    for (const table of [
      "instances",
      "jobs",
      "schedules",
      "backups",
      "players",
    ])
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY,data TEXT NOT NULL)`,
      );
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM kv WHERE key=?")
      .get(key) as any;
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  list<T>(table: Table): T[] {
    return (this.db.prepare(`SELECT data FROM ${table}`).all() as any[]).map(
      (row) => JSON.parse(row.data),
    );
  }
  put(table: Table, value: { id: string }) {
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, JSON.stringify(value));
  }
  delete(table: Table, id: string) {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  instances() {
    return this.list<Instance>("instances").sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }
  instance(id: string) {
    const item = this.instances().find((i) => i.id === id);
    if (!item) throw new Error("实例不存在");
    return item;
  }
  settings(): Settings {
    return this.get("settings", {
      theme: "dark",
      reducedMotion: false,
      notifications: true,
      backupRetention: 7,
      historyDays: 7,
      backupRoot: path.join(this.root, "backups"),
      closeToTray: true,
      launchAtLogin: false,
      commandFavorites: ["list", "status", "say 欢迎来到方舟！"],
    });
  }
  activity(instanceId: string | null, text: string, level = "info"): Activity {
    const entry = { id: randomUUID(), instanceId, at: Date.now(), level, text };
    this.db
      .prepare("INSERT INTO activity VALUES(?,?,?,?,?)")
      .run(entry.id, entry.instanceId, entry.at, entry.level, entry.text);
    return entry;
  }
  activities(limit = 100): Activity[] {
    return this.db
      .prepare("SELECT * FROM activity ORDER BY at DESC LIMIT ?")
      .all(limit) as unknown as Activity[];
  }
  metric(instanceId: string, m: Metric) {
    this.db
      .prepare("INSERT INTO metrics VALUES(?,?,?,?,?,?,?)")
      .run(instanceId, m.at, m.cpu, m.memory, m.tps, m.mspt, m.players);
  }
  history(instanceId: string, since: number): Metric[] {
    const span = Date.now() - since;
    const bucket = span > 86400000 ? 900000 : span > 3600000 ? 60000 : 5000;
    return this.db
      .prepare(
        "SELECT (at / ?)*? as at,avg(cpu) as cpu,avg(memory) as memory,avg(tps) as tps,avg(mspt) as mspt,max(players) as players FROM metrics WHERE instanceId=? AND at>=? GROUP BY at / ? ORDER BY at",
      )
      .all(bucket, bucket, instanceId, since, bucket) as unknown as Metric[];
  }
  prune() {
    this.db
      .prepare("DELETE FROM metrics WHERE at < ?")
      .run(Date.now() - this.settings().historyDays * 86400000);
    this.db
      .prepare("DELETE FROM activity WHERE at < ?")
      .run(Date.now() - 90 * 86400000);
  }
  jobs() {
    return jobWindow(this.list<Job>("jobs"));
  }
  schedules() {
    return this.list<Schedule>("schedules");
  }
  backups(id?: string) {
    return this.list<Backup>("backups")
      .filter((b) => !id || b.instanceId === id)
      .sort((a, b) => b.at - a.at);
  }
  playerKey(id: string, name: string) {
    return `${id}:${name.toLocaleLowerCase()}`;
  }
  players(id: string): Player[] {
    return this.list<Player & { id: string; instanceId: string }>(
      "players",
    ).filter((p) => p.instanceId === id);
  }
  savePlayer(id: string, player: Player) {
    this.put("players", {
      ...player,
      id: this.playerKey(id, player.name),
      instanceId: id,
    } as any);
  }
  close() {
    this.db.close();
  }
}
export const defaultDataRoot = () =>
  process.env.ARK_MC_DATA ||
  path.join(
    process.env.APPDATA || path.join(os.homedir(), ".config"),
    "ArkMC Studio",
  );
