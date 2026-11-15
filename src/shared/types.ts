export type Core = "endstone" | "bds";
export interface CoreUpdatePolicy {
  autoCheck: boolean;
  autoUpdate: boolean;
  intervalHours: number;
  maintenanceTime: string;
  incompatibleEndstone: "wait" | "official-bds";
}
export interface CoreUpdateReport {
  checkedAt: number;
  core: Core;
  currentBds: string;
  currentEndstone: string;
  latestBds?: string;
  latestEndstone?: string;
  compatibleBds?: string;
  targetCore?: Core;
  updateAvailable: boolean;
  status: "current" | "available" | "unknown" | "unavailable";
  detail: string;
  error?: string;
  releaseUrl: string;
}
export interface CoreUpdateState {
  policy: CoreUpdatePolicy;
  report: CoreUpdateReport | null;
  nextCheckAt?: number;
  nextUpdateAt?: number;
  maintenanceWindowAt?: number;
  lastOutcome?: { at: number; detail: string; jobId?: string };
}
export interface RouteQualitySample {
  ok: boolean;
  elapsedMs: number;
  error?: string;
}
export interface RouteQuality {
  signalId: number;
  name: string;
  host: string;
  port: number;
  checkedAt: number;
  samples: RouteQualitySample[];
  failureRate: number;
  medianMs: number | null;
  p95Ms: number | null;
  jitterMs: number | null;
  transport: {
    status: "pass" | "fail" | "skipped";
    detail: string;
    connectMs?: number;
  };
}
export interface RouteQualityReport {
  checkedAt: number;
  routes: RouteQuality[];
  recommendedSignalId?: number;
  scope: string;
}
export type Status =
  "running" | "stopped" | "starting" | "stopping" | "unmanaged" | "unknown";
export interface Instance {
  id: string;
  name: string;
  root: string;
  core: Core;
  preferredCore?: Core;
  adapter: "legacy" | "managed";
  python?: string;
  tunnelRoot?: string;
  endpointPath?: string;
  createdAt: number;
  version?: string;
}
export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  path: string;
  command: string;
  memory: number;
  cpuTime: number;
  createdAt: number;
}
export interface Metric {
  at: number;
  cpu: number | null;
  memory: number | null;
  tps: number | null;
  mspt: number | null;
  players: number | null;
}
export interface Snapshot {
  id: string;
  status: Status;
  pid: number | null;
  startedAt: number | null;
  world: string;
  port: number;
  transport: string;
  maxPlayers: number;
  version: string;
  endstoneVersion: string;
  metric: Metric;
  players: Player[];
  capabilities: {
    command: boolean;
    tps: boolean;
    managed: boolean;
    sessionHost?: boolean;
  };
  lastError?: string;
}
export interface Player {
  name: string;
  xuid?: string;
  online: boolean;
  joinedAt?: number;
  totalSeconds: number;
  lastSeen: number;
}
export interface LogLine {
  seq: number;
  at: number;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  text: string;
}
export interface Job {
  id: string;
  instanceId: string | null;
  type: string;
  title: string;
  status:
    "queued" | "running" | "success" | "failed" | "cancelled" | "interrupted";
  progress: number;
  detail: string;
  createdAt: number;
  finishedAt?: number;
  result?: unknown;
}
export interface Schedule {
  id: string;
  instanceId: string;
  name: string;
  cron: string;
  action: "backup" | "restart" | "start" | "stop" | "command";
  command?: string;
  enabled: boolean;
  nextAt: number;
  lastAt?: number;
  lastError?: string;
}
export interface Settings {
  theme: "dark" | "light";
  reducedMotion: boolean;
  notifications: boolean;
  backupRetention: number;
  historyDays: number;
  backupRoot: string;
  closeToTray: boolean;
  launchAtLogin: boolean;
  commandFavorites: string[];
}
export interface Activity {
  id: string;
  instanceId: string | null;
  at: number;
  level: string;
  text: string;
}
export interface Bootstrap {
  instances: Instance[];
  snapshots: Snapshot[];
  settings: Settings;
  jobs: Job[];
  schedules: Schedule[];
  activities: Activity[];
  dataRoot: string;
  agentVersion: string;
  features?: { sessionHosts: boolean; gracefulShutdown: boolean };
  programUpdating?: boolean;
  samplerReady: boolean;
}
export interface Backup {
  id: string;
  instanceId: string;
  kind: "world" | "full";
  name: string;
  at: number;
  size: number;
  files: number;
  sha256: string;
  world: string;
  version: string;
  verified: boolean;
  automatic: boolean;
}
export interface World {
  name: string;
  active: boolean;
  size?: number;
  modified: number;
  behaviorPacks: number;
  resourcePacks: number;
}
export interface Pack {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: "behavior" | "resource" | "plugin";
  path: string;
  enabled: boolean;
  dependencies: string[];
  missingDependencies: string[];
  icon?: string;
  system: boolean;
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
  modified: number;
}
export interface TextFile {
  path: string;
  text: string;
  revision: string;
  bom: boolean;
}
export interface Tunnel {
  id: number;
  provider?: "lolia" | "sakura" | "frp-panel";
  node: string;
  serverAddr?: string;
  serverPort?: number;
  type: string;
  running: boolean;
  pid?: number;
  localIP: string;
  localPort: number;
  remotePort?: number;
  publicPort?: number;
  host?: string;
  pluginTarget?: string;
  autoTLS?: boolean;
}
export interface Route {
  name: string;
  host: string;
  port: number;
  protocol?: "http" | "https";
  signalId: number;
  udpId?: number;
  udpHost?: string;
  udpPort?: number;
  signalRunning: boolean;
  udpRunning: boolean;
  targetIP?: string;
  targetPort?: number;
  router: boolean;
  signalingTarget?: string;
  routerHealthy?: boolean;
  routerRunning?: boolean;
  clientReady?: boolean;
  clientError?: string;
  pairingAmbiguous?: boolean;
}
export interface Diagnostic {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  duration?: number;
}
export interface AgentEvent {
  type: "snapshot" | "logs" | "job" | "activity" | "settings";
  data: unknown;
  instanceId?: string;
}
export type ToolId = "lolia" | "sakura" | "frp" | "uv";
export interface ToolInfo {
  tool: ToolId;
  name: string;
  installedVersion?: string;
  latestVersion?: string;
  executable?: string;
  source: string;
  updateAvailable: boolean;
  bundled?: boolean;
  error?: string;
}
export interface SignalRouterConfig {
  key: string;
  name: string;
  signalId: number;
  udpId: number;
  enabled: boolean;
  listenIP: string;
  listenPort: number;
  upstream: string;
  sourceUdpIP: string;
  sourceUdpPort: number;
  publicUdpIP: string;
  publicUdpPort: number;
  relayOnly: boolean;
}
export interface ArkBridge {
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  chooseDirectory(): Promise<string | null>;
  chooseFile(
    filters?: { name: string; extensions: string[] }[],
  ): Promise<string | null>;
  saveFile(name: string, content: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
  window(action: "minimize" | "maximize" | "close"): void;
  setLogin(enabled: boolean): Promise<void>;
  reloadBackend(): Promise<Bootstrap>;
  versions: { app: string; electron: string; chrome: string };
}
declare global {
  interface Window {
    ark: ArkBridge;
  }
}
