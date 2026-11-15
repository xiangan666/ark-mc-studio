import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeInstance,
  analyzeLogs,
  metricSeries,
  metricChartPoints,
  metricsCsv,
  routeRows,
  summarizeMetric,
  selectRoutes,
} from "../src/renderer/analysis";
import type {
  Job,
  LogLine,
  Metric,
  Route,
  RouteQualityReport,
  Snapshot,
} from "../src/shared/types";
const now = 1800000000000;
const sample = (at: number, cpu: number | null = 5): Metric => ({
  at,
  cpu,
  memory: 1024 ** 3,
  tps: null,
  mspt: null,
  players: 0,
});
test("图表使用当前指标的有效采样间隔，保留空值并断开真实时间缺口", () => {
  const metrics = [0, 30000, 60000, 300000].map((at) => sample(now + at, 40));
  for (let i = 1; i < 10; i++)
    metrics.push(sample(now + 300000 + i * 2000, null));
  const before = JSON.stringify(metrics);
  const points = metricChartPoints(metrics, "cpu");
  assert.deepEqual(points.slice(0, 5), [
    [now, 40],
    [now + 30000, 40],
    [now + 60000, 40],
    [now + 60001, null],
    [now + 300000, 40],
  ]);
  assert.equal(points.filter((p) => p[1] !== null).length, 4);
  assert.equal(metricChartPoints([sample(now)], "memory")[0][1], 1024);
  assert.equal(JSON.stringify(metrics), before);
});
test("性能序列按窗口去重排序并拒绝未来时间、无效数值，不把缺失当作零", () => {
  const result = metricSeries(
    [
      sample(now - 9000000),
      sample(now - 1000, 10),
      sample(now + 1),
      sample(now - 2000, NaN),
    ],
    sample(now - 1000, 20),
    1,
    now,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].cpu, null);
  assert.equal(result[1].cpu, 20);
  assert.equal(summarizeMetric(result, "tps").average, null);
  assert.equal(summarizeMetric(result, "players").average, 0);
});
test("聚合样本的均值、峰值和最近秩 P95 计算正确", () => {
  const result = summarizeMetric(
    Array.from({ length: 20 }, (_, i) => sample(now - 1000 * (20 - i), i + 1)),
    "cpu",
  );
  assert.equal(result.average, 10.5);
  assert.equal(result.max, 20);
  assert.equal(result.p95, 19);
  assert.equal(result.delta, 10);
  assert.equal(summarizeMetric([sample(now, 1)], "cpu").delta, null);
});
test("日志按窗口、等级和模式统计，保留最近证据并给出有限规则建议", () => {
  const lines: LogLine[] = [
    {
      seq: 1,
      at: now - 1000,
      level: "ERROR",
      text: "[INFO]: EADDRINUSE port 1234",
    },
    { seq: 2, at: now, level: "ERROR", text: "[INFO]: EADDRINUSE port 2345" },
    { seq: 3, at: now, level: "WARN", text: "disk warning" },
    { seq: 4, at: now - 90000, level: "ERROR", text: "old" },
  ];
  const result = analyzeLogs(lines, now - 60000, now);
  assert.equal(result.total, 3);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].count, 2);
  assert.match(result.groups[0].hint, /端口占用/);
  assert.match(result.groups[0].sample, /2345/);
});
const route: Route = {
  name: "测试入口",
  host: "mc.example.com",
  port: 443,
  signalId: 1,
  signalRunning: true,
  udpRunning: true,
  router: true,
};
const report = (checkedAt: number, host = route.host): RouteQualityReport => ({
  checkedAt,
  scope: "fixture",
  routes: [
    {
      signalId: 1,
      name: route.name,
      host,
      port: route.port,
      checkedAt,
      samples: [],
      failureRate: 0,
      medianMs: 20,
      p95Ms: 30,
      jitterMs: 1,
      transport: { status: "pass", detail: "fixture" },
    },
  ],
});
test("进程就绪不等于握手通过；检测过期、改地址、未来报告不能冒充近期成功", () => {
  assert.equal(routeRows([route], null, null, now)[0].transport, "unknown");
  assert.equal(routeRows([route], null, report(now), now)[0].transport, "pass");
  assert.equal(
    routeRows([route], null, report(now - 16 * 60000), now)[0].transport,
    "stale",
  );
  assert.equal(
    routeRows([route], null, report(now, "old.example.com"), now)[0].transport,
    "unknown",
  );
  assert.equal(
    routeRows([route], null, report(now + 1000), now)[0].transport,
    "stale",
  );
  assert.equal(
    routeRows(
      [route],
      {
        configured: true,
        running: true,
        ready: true,
        enabled: true,
        domain: "v6.example.com",
        httpsPort: 8443,
      },
      null,
      now,
    ).length,
    2,
  );
});
test("分析仅读取已有记录，无样本不伪造健康，无取消任务误算失败", () => {
  const jobs = ["success", "failed", "cancelled", "running"].map(
    (status, i) => ({
      id: String(i),
      instanceId: "fixture",
      type: "fixture",
      title: "fixture",
      status,
      progress: 100,
      detail: "fixture",
      createdAt: now - 1000,
    }),
  ) as Job[];
  const input = {
    metrics: [],
    logs: [],
    jobs,
    backups: [],
    routes: [],
    since: now - 3600000,
    now,
    backupsLoaded: false,
  };
  const before = JSON.stringify(input);
  const result = analyzeInstance(input);
  assert.equal(result.jobs.successRate, 50);
  assert.equal(result.jobs.failed, 1);
  assert(result.findings.some((f) => f.code === "metrics-missing"));
  assert(!result.findings.some((f) => f.code === "backup-missing"));
  assert.equal(JSON.stringify(input), before);
});
test("阈值仅在有足够实测数据时产生观察，不推算 BDS TPS", () => {
  const metrics = Array.from({ length: 8 }, (_, i) => ({
    ...sample(now - 1000 * (8 - i), 80),
    tps: 10,
  }));
  const result = analyzeInstance({
    snapshot: { capabilities: { tps: false } } as Snapshot,
    metrics,
    logs: [],
    jobs: [],
    backups: [],
    routes: [],
    since: now - 3600000,
    now,
    backupsLoaded: true,
  });
  assert(result.findings.some((f) => f.code === "cpu-high"));
  assert(!result.findings.some((f) => f.code === "tps-low"));
});
test("CSV 包含单位、UTC 时间和 BOM；缺失指标留空", () => {
  const csv = metricsCsv([sample(now, null)]);
  assert(
    csv.startsWith("\uFEFFtime,cpu_percent,memory_bytes,tps,mspt,players\r\n"),
  );
  assert.match(csv, /Z,,1073741824,,,0$/);
});
test("长窗口的聚合桶时间不被当成停止刷新", () => {
  const result = analyzeInstance({
    metrics: [sample(now - 12 * 60000)],
    logs: [],
    jobs: [],
    backups: [],
    routes: [],
    since: now - 7 * 86400000,
    now,
    backupsLoaded: false,
  });
  assert(!result.findings.some((f) => f.code === "metrics-missing"));
});
test("线路搜索与状态筛选仅读取观察状态，不改变配置或隐式优选", () => {
  const rows = routeRows(
    [route],
    {
      configured: true,
      running: false,
      enabled: false,
      ready: false,
      domain: "v6.example.com",
      httpsPort: 8443,
    },
    report(now),
    now,
  );
  assert.equal(selectRoutes(rows, "V6.EXAMPLE", "all")[0].kind, "direct");
  assert.equal(selectRoutes(rows, "", "attention").length, 1);
  assert.equal(selectRoutes(rows, "", "unverified").length, 1);
  assert.equal(selectRoutes(rows, "", "direct").length, 1);
  assert.equal(selectRoutes(rows, "absent", "all").length, 0);
  assert.equal(rows.length, 2);
});
