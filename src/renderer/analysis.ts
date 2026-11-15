import type {
  Backup,
  Job,
  LogLine,
  Metric,
  Route,
  RouteQualityReport,
  Snapshot,
} from "../shared/types";
import type { DirectRouteStatus } from "../shared/direct";

export type MetricKind = "cpu" | "memory" | "tps" | "players";
export interface Finding {
  code: string;
  tone: "warn" | "info";
  title: string;
  detail: string;
  page: "overview" | "console" | "backups" | "tasks" | "network";
}
export function metricSeries(
  history: Metric[],
  latest: Metric | undefined,
  hours: number,
  now = Date.now(),
): Metric[] {
  const byTime = new Map<number, Metric>();
  for (const item of [...history, ...(latest ? [latest] : [])]) {
    if (
      !Number.isFinite(item.at) ||
      item.at < now - hours * 3600000 ||
      item.at > now
    )
      continue;
    const clean = { ...item };
    for (const key of ["cpu", "memory", "tps", "mspt", "players"] as const) {
      const value = clean[key];
      if (value !== null && (!Number.isFinite(value) || value < 0))
        clean[key] = null;
    }
    byTime.set(item.at, clean);
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}
export function summarizeMetric(metrics: Metric[], kind: MetricKind) {
  const values = metrics
    .map((item) => item[kind])
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (!values.length)
    return {
      count: 0,
      average: null,
      min: null,
      max: null,
      p95: null,
      delta: null,
    };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = (items: number[]) =>
    items.reduce((a, b) => a + b, 0) / items.length;
  const half = Math.floor(values.length / 2);
  return {
    count: values.length,
    average: mean(values),
    min: sorted[0],
    max: sorted.at(-1)!,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    delta:
      values.length >= 4
        ? mean(values.slice(-half)) - mean(values.slice(0, half))
        : null,
  };
}
export function metricChartPoints(metrics: Metric[], kind: MetricKind) {
  // Missing values for other metrics must not change this series' cadence.
  const valid = metrics.filter((m) => m[kind] !== null);
  const steps = valid
    .slice(1)
    .map((m, i) => m.at - valid[i].at)
    .filter((step) => step > 0)
    .sort((a, b) => a - b);
  const cadence = steps[Math.floor(steps.length / 2)] || 0;
  return metrics.flatMap((m, i): [number, number | null][] => {
    const value = m[kind];
    const point: [number, number | null] = [
      m.at,
      kind === "memory" && value !== null ? value / 1024 ** 2 : value,
    ];
    return i && cadence && m.at - metrics[i - 1].at > cadence * 3
      ? [[metrics[i - 1].at + 1, null], point]
      : [point];
  });
}
export function analyzeLogs(lines: LogLine[], since = 0, now = Date.now()) {
  const selected = lines.filter((line) => line.at >= since && line.at <= now);
  const counts = { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 };
  const groups = new Map<
    string,
    {
      key: string;
      level: string;
      count: number;
      sample: string;
      lastAt: number;
      hint: string;
    }
  >();
  for (const line of selected) {
    counts[line.level]++;
    if (line.level !== "WARN" && line.level !== "ERROR") continue;
    const sample = line.text.slice(0, 2048).replace(/^\[[^\]]+\]:?\s*/, "");
    const key = `${line.level}:${sample.replace(/\b(?:0x[\da-f]+|\d+)\b/gi, "#").trim()}`;
    const old = groups.get(key);
    if (old) {
      old.count++;
      if (line.at > old.lastAt) {
        old.lastAt = line.at;
        old.sample = sample;
      }
      continue;
    }
    const hint = /address already in use|EADDRINUSE|端口.*占用/i.test(sample)
      ? "检查端口占用与实例端口配置；分析页不会结束占用进程。"
      : /permission denied|access.*denied|EACCES|权限不足/i.test(sample)
        ? "核对相关文件或目录权限，避免直接覆盖正在使用的数据。"
        : /no space|ENOSPC|磁盘.*满|空间不足/i.test(sample)
          ? "检查数据盘和备份盘剩余空间。"
          : /missing.*depend|dependenc.*not found|缺.*依赖/i.test(sample)
            ? "前往模组与插件核对依赖和核心版本。"
            : "查看前后日志确认原因；单条记录不能证明服务故障。";
    groups.set(key, {
      key,
      level: line.level,
      count: 1,
      sample,
      lastAt: line.at,
      hint,
    });
  }
  return {
    total: selected.length,
    counts,
    firstAt: selected.length ? Math.min(...selected.map((l) => l.at)) : null,
    lastAt: selected.length ? Math.max(...selected.map((l) => l.at)) : null,
    groups: [...groups.values()]
      .sort(
        (a, b) =>
          (a.level === b.level ? 0 : a.level === "ERROR" ? -1 : 1) ||
          b.count - a.count ||
          b.lastAt - a.lastAt,
      )
      .slice(0, 20),
  };
}
export interface RouteRow {
  key: string;
  name: string;
  address: string;
  kind: "direct" | "tunnel";
  running: boolean;
  pending: boolean;
  transport: "pass" | "fail" | "stale" | "unknown";
  checkedAt?: number;
  medianMs?: number | null;
}
export type RouteFilter = "all" | "attention" | "unverified" | "direct";
export function selectRoutes(
  rows: RouteRow[],
  search: string,
  filter: RouteFilter,
) {
  const term = search.toLocaleLowerCase().trim();
  return rows.filter(
    (row) =>
      (!term ||
        `${row.name} ${row.address}`.toLocaleLowerCase().includes(term)) &&
      (filter === "attention"
        ? row.pending || row.transport === "fail"
        : filter === "unverified"
          ? row.transport === "unknown" || row.transport === "stale"
          : filter === "direct"
            ? row.kind === "direct"
            : true),
  );
}
export function routeRows(
  routes: Route[],
  direct: DirectRouteStatus | null,
  quality: RouteQualityReport | null,
  now = Date.now(),
): RouteRow[] {
  const rows: RouteRow[] = [];
  if (direct?.configured) {
    const checkedAt = Date.parse(direct.diagnostic?.testedAt || "");
    const fresh =
      Number.isFinite(checkedAt) &&
      checkedAt <= now &&
      now - checkedAt < 10 * 60000;
    rows.push({
      key: "direct",
      name: direct.name || "本机 IPv6 公网直连",
      address: `${direct.domain}:${direct.httpsPort}`,
      kind: "direct",
      running: !!direct.running && !!direct.ready,
      pending: !direct.enabled || !direct.ready || direct.ddns?.ok === false,
      checkedAt: Number.isFinite(checkedAt) ? checkedAt : undefined,
      transport: !direct.diagnostic
        ? "unknown"
        : !fresh
          ? "stale"
          : direct.diagnostic.checks.length &&
              direct.diagnostic.checks.every((c) => c.ok)
            ? "pass"
            : "fail",
    });
  }
  for (const route of routes) {
    const result = quality?.routes.find(
      (q) =>
        q.signalId === route.signalId &&
        q.host === route.host &&
        q.port === route.port,
    );
    const fresh =
      !!result &&
      result.checkedAt <= now &&
      now - result.checkedAt < 15 * 60000;
    rows.push({
      key: `tunnel-${route.signalId}`,
      name: route.name,
      address: `${route.host}:${route.port}`,
      kind: "tunnel",
      running:
        route.signalRunning &&
        route.udpRunning &&
        (!route.router || route.routerHealthy !== false),
      pending:
        !route.signalRunning ||
        !route.udpRunning ||
        (route.router && route.routerHealthy === false) ||
        route.clientReady === false,
      checkedAt: result?.checkedAt,
      medianMs: result?.medianMs,
      transport: !result
        ? "unknown"
        : !fresh
          ? "stale"
          : result.transport.status === "pass"
            ? "pass"
            : result.transport.status === "fail"
              ? "fail"
              : "unknown",
    });
  }
  return rows;
}
export const transportLabel = {
  pass: "握手通过",
  fail: "检测失败",
  stale: "结果已过期",
  unknown: "未验证",
};
export function analyzeInstance(input: {
  snapshot?: Snapshot;
  metrics: Metric[];
  logs: LogLine[];
  jobs: Job[];
  backups: Backup[];
  routes: RouteRow[];
  since: number;
  now?: number;
  backupsLoaded: boolean;
}) {
  const now = input.now ?? Date.now();
  const cpu = summarizeMetric(input.metrics, "cpu");
  const memory = summarizeMetric(input.metrics, "memory");
  const tps = summarizeMetric(input.metrics, "tps");
  const players = summarizeMetric(input.metrics, "players");
  const logs = analyzeLogs(input.logs, input.since, now);
  const jobs = input.jobs.filter(
    (j) => j.createdAt >= input.since && j.createdAt <= now,
  );
  const completed = jobs.filter((j) =>
    ["success", "failed", "interrupted"].includes(j.status),
  );
  const failed = completed.filter((j) => j.status !== "success").length;
  const backups = [...input.backups].sort((a, b) => b.at - a.at);
  const findings: Finding[] = [];
  const add = (
    code: string,
    tone: Finding["tone"],
    title: string,
    detail: string,
    page: Finding["page"],
  ) => findings.push({ code, tone, title, detail, page });
  const latestAt = input.snapshot?.metric?.at ?? input.metrics.at(-1)?.at;
  const freshnessLimit = input.snapshot
    ? 60000
    : now - input.since > 86400000
      ? 16 * 60000
      : now - input.since > 3600000
        ? 2 * 60000
        : 60000;
  if (!input.metrics.length || !latestAt || now - latestAt > freshnessLimit)
    add(
      "metrics-missing",
      "info",
      "性能数据不足或已停止刷新",
      "没有近期样本，无法据此判断当前性能；请查看后台连接与实例状态。",
      "overview",
    );
  if ((cpu.average ?? 0) >= 70 && cpu.count >= 6)
    add(
      "cpu-high",
      "warn",
      "窗口内 CPU 平均占用较高",
      `平均 ${cpu.average!.toFixed(1)}%，基于 ${cpu.count} 个聚合样本。检查同时段负载与日志。`,
      "overview",
    );
  if (
    input.snapshot?.capabilities.tps &&
    tps.count >= 6 &&
    (tps.average ?? 20) < 18
  )
    add(
      "tps-low",
      "warn",
      "窗口内 TPS 平均值偏低",
      `平均 ${tps.average!.toFixed(2)}；可结合 MSPT、人数和插件日志排查。`,
      "overview",
    );
  if (
    memory.count >= 6 &&
    memory.delta !== null &&
    memory.delta > 512 * 1024 ** 2 &&
    memory.min !== null &&
    memory.delta > memory.min * 0.25
  )
    add(
      "memory-rising",
      "info",
      "窗口后半段内存占用上升",
      "后半段均值较前半段增加超过 512 MB 且超过最低值的 25%；这是趋势观察，不能单独判定内存泄漏。",
      "overview",
    );
  if (logs.counts.ERROR)
    add(
      "log-errors",
      "warn",
      `缓存中有 ${logs.counts.ERROR} 条错误日志`,
      "以当前后台最近保留的日志为限，可打开控制台查看原文与上下文。",
      "console",
    );
  if (failed)
    add(
      "job-errors",
      "warn",
      `当前窗口有 ${failed} 项任务失败或中断`,
      "统计仅包含后台返回的近期任务；前往任务与记录查看具体原因。",
      "tasks",
    );
  if (input.backupsLoaded && !backups.length)
    add(
      "backup-missing",
      "info",
      "尚未登记备份",
      "备份列表中没有记录；可在合适的维护安排下创建备份，分析不会自动执行。",
      "backups",
    );
  if (input.backupsLoaded && backups[0] && now - backups[0].at > 86400000)
    add(
      "backup-old",
      "info",
      "最近备份距今超过 24 小时",
      "请结合你的备份周期评估；备份时间不代表当前世界可恢复性。",
      "backups",
    );
  if (input.routes.some((r) => r.pending || r.transport === "fail"))
    add(
      "route-attention",
      "warn",
      "部分入口需要检查",
      "存在未就绪进程或最近检测失败的入口。这里仅读取状态，不触发线路检测或重启。",
      "network",
    );
  return {
    cpu,
    memory,
    tps,
    players,
    logs,
    jobs: {
      total: jobs.length,
      completed: completed.length,
      failed,
      successRate: completed.length
        ? ((completed.length - failed) / completed.length) * 100
        : null,
    },
    backups: {
      count: backups.length,
      latestAt: backups[0]?.at ?? null,
      unverified: backups.filter((b) => !b.verified).length,
    },
    findings: findings.sort((a, b) =>
      a.tone === b.tone ? 0 : a.tone === "warn" ? -1 : 1,
    ),
  };
}
export function metricsCsv(metrics: Metric[]) {
  return (
    "\uFEFFtime,cpu_percent,memory_bytes,tps,mspt,players\r\n" +
    metrics
      .map((m) =>
        [
          new Date(m.at).toISOString(),
          m.cpu,
          m.memory,
          m.tps,
          m.mspt,
          m.players,
        ]
          .map((v) => v ?? "")
          .join(","),
      )
      .join("\r\n")
  );
}
