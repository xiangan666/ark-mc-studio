import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  FileText,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type {
  Backup,
  LogLine,
  Metric,
  Route,
  RouteQualityReport,
} from "../../shared/types";
import type { DirectRouteStatus } from "../../shared/direct";
import {
  analyzeInstance,
  metricSeries,
  metricsCsv,
  routeRows,
  summarizeMetric,
  transportLabel,
  type MetricKind,
} from "../analysis";
import {
  Badge,
  Button,
  Chart,
  Empty,
  Heading,
  Notice,
  Panel,
  PageTabs,
  tabPanelProps,
  useQuery,
} from "../components";
import { bytes, date, message, useApp } from "../store";
import { readPreference } from "../navigation";

const metricNames = {
  cpu: "CPU 使用率",
  memory: "内存工作集",
  tps: "服务器 TPS",
  players: "在线人数",
};
const format = (value: number | null, kind: MetricKind) =>
  value === null
    ? "—"
    : kind === "memory"
      ? bytes(value)
      : kind === "cpu"
        ? `${value.toFixed(1)}%`
        : kind === "players"
          ? value.toFixed(1)
          : value.toFixed(2);
export default function AnalysisPage() {
  const id = useApp((s) => s.selected);
  const data = useApp((s) => s.data)!;
  const logs = useApp((s) => s.logs[id]);
  const navigate = useApp((s) => s.navigate);
  const snapshot = data.snapshots.find((s) => s.id === id);
  const [hours, setHours] = useState(() => {
    const saved = readPreference<number>("ark.analysis-hours", 1);
    return [0.25, 1, 6, 24, 168].includes(saved) ? saved : 1;
  });
  const [kind, setKind] = useState<MetricKind>("cpu");
  const [tab, setTab] = useState("performance");
  const [exporting, setExporting] = useState(false);
  const history = useQuery<Metric[]>("metrics.history", { id, hours }, 15000);
  const logQuery = useQuery<LogLine[]>("console.logs", { id }, 20000);
  const backups = useQuery<Backup[]>("backups.list", { id }, 60000);
  const network = useQuery<{ routes: Route[] }>("tunnels.get", { id }, 15000);
  const direct = useQuery<DirectRouteStatus>("direct.get", { id }, 15000);
  const quality = useQuery<RouteQualityReport | null>(
    "tunnels.quality.get",
    { id },
    20000,
  );
  useEffect(() => {
    if (logQuery.data) useApp.getState().mergeLogs(id, logQuery.data);
  }, [logQuery.data, id]);
  const now = Date.now();
  const metrics = useMemo(
    () => metricSeries(history.data || [], undefined, hours),
    [history.data, hours],
  );
  const routes = routeRows(
    network.data?.routes || [],
    direct.data,
    quality.data,
    now,
  );
  const analysis = analyzeInstance({
    snapshot,
    metrics,
    logs: logs || logQuery.data || [],
    jobs: data.jobs.filter((j) => j.instanceId === id),
    backups: backups.data || [],
    backupsLoaded: backups.data !== null && !backups.error,
    routes,
    since: now - hours * 3600000,
    now,
  });
  const queries = [history, logQuery, backups, network, direct, quality];
  const errors = queries.map((q) => q.error).filter(Boolean);
  const metricSummary = summarizeMetric(metrics, kind);
  const refresh = () => queries.forEach((q) => q.reload());
  const windowLabel =
    hours === 0.25
      ? "最近 15 分钟"
      : hours === 168
        ? "最近 7 天"
        : `最近 ${hours} 小时`;
  async function exportData(csv: boolean) {
    setExporting(true);
    try {
      const { groups, ...logCounts } = analysis.logs;
      const report = {
        schemaVersion: 1,
        appVersion: window.ark.versions.app,
        generatedAt: new Date().toISOString(),
        windowHours: hours,
        sampleCount: metrics.length,
        observedFrom: metrics[0]?.at ?? null,
        observedTo: metrics.at(-1)?.at ?? null,
        metrics: {
          cpu: analysis.cpu,
          memory: analysis.memory,
          tps: analysis.tps,
          players: analysis.players,
        },
        jobs: analysis.jobs,
        backups: analysis.backups,
        logs: { ...logCounts, patternCount: groups.length },
        network: {
          entries: routes.length,
          processesReady: routes.filter((r) => r.running).length,
          freshHandshakePass: routes.filter((r) => r.transport === "pass")
            .length,
        },
        findings: analysis.findings,
        unavailableSources: queries
          .map((q, i) =>
            q.error
              ? ["metrics", "logs", "backups", "network", "direct", "quality"][
                  i
                ]
              : null,
          )
          .filter(Boolean),
        sources: Object.fromEntries(
          queries.map((q, i) => [
            ["metrics", "logs", "backups", "network", "direct", "quality"][i],
            {
              loaded: q.updatedAt > 0,
              failed: !!q.error,
              updatedAt: q.updatedAt || null,
            },
          ]),
        ),
        scope:
          "只读观察；聚合桶样本统计；日志和任务仅覆盖后台当前返回的记录。传输握手不代表真实账号登录。未导出实例路径、连接地址、凭据或日志正文。",
      };
      const saved = await window.ark.saveFile(
        `ArkMC-运行分析-${hours}h-${Date.now()}.${csv ? "csv" : "json"}`,
        csv ? metricsCsv(metrics) : JSON.stringify(report, null, 2),
      );
      if (saved)
        useApp
          .getState()
          .toast(
            csv ? "性能数据已导出" : "分析摘要已导出，不含日志正文与连接凭据",
          );
    } catch (error) {
      useApp.getState().toast(message(error), "error");
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="page analysis-page">
      <Heading
        eyebrow="OBSERVE · UNDERSTAND · DECIDE"
        title="运行分析"
        description="按时间查看性能采样、日志问题和运维记录。"
        actions={
          <>
            <Badge tone="green">
              <ShieldCheck size={13} />
              只读分析
            </Badge>
            <Button onClick={refresh} disabled={queries.some((q) => q.loading)}>
              <RefreshCw size={14} className={history.loading ? "spin" : ""} />
              刷新数据
            </Button>
            <Button
              onClick={() => void exportData(false)}
              disabled={exporting || history.loading}
            >
              <ArrowDownToLine size={14} />
              导出摘要
            </Button>
          </>
        }
      />
      <div className="analysis-window toolbar-surface">
        <div className="segmented" aria-label="分析时间范围">
          {[0.25, 1, 6, 24, 168].map((value) => (
            <button
              key={value}
              className={hours === value ? "active" : ""}
              aria-pressed={hours === value}
              onClick={() => {
                setHours(value);
                localStorage.setItem(
                  "ark.analysis-hours",
                  JSON.stringify(value),
                );
              }}
            >
              {value === 0.25
                ? "15 分钟"
                : value === 168
                  ? "7 天"
                  : `${value} 小时`}
            </button>
          ))}
        </div>
        <span className="source-status">
          <Clock3 size={13} />
          {history.loading
            ? "正在读取性能历史…"
            : `${metrics.length} 个时间点 · ${date(metrics.at(-1)?.at)}`}
        </span>
      </div>
      {!!errors.length && (
        <Notice tone="warn">
          <span>
            部分数据读取失败，相关结论暂不完整。
            {[...new Set(errors)].join("；")}
          </span>
          <Button onClick={refresh}>重试读取</Button>
        </Notice>
      )}
      <PageTabs
        id="analysis"
        label="运行分析分类"
        value={tab}
        onChange={setTab}
        items={[
          { value: "performance", label: "性能趋势" },
          {
            value: "findings",
            label: "观察与建议",
            count: analysis.findings.length,
          },
          { value: "logs", label: "日志归类" },
          { value: "operations", label: "运维与入口" },
        ]}
      />
      <div {...tabPanelProps("analysis", tab)} className="tab-content">
        <section
          className="analysis-performance"
          hidden={tab !== "performance"}
          aria-label="性能分析工作区"
        >
          <div className="analysis-kpis">
            {(["cpu", "memory", "tps", "players"] as const).map((key) => {
              const value = analysis[key];
              return (
                <button
                  key={key}
                  className={`analysis-stat ${kind === key ? "selected" : ""}`}
                  onClick={() => setKind(key)}
                  aria-pressed={kind === key}
                >
                  <span>{metricNames[key]}</span>
                  <strong>
                    {format(value.average, key)}
                    <small>样本均值</small>
                  </strong>
                  <div>
                    <span>峰值 {format(value.max, key)}</span>
                    <span>{value.count} 样本</span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="analysis-chart-grid">
            <Panel
              title="性能趋势"
              subtitle={`${windowLabel} · ${metricNames[kind]}`}
              aside={
                <Button
                  variant="ghost"
                  disabled={!metrics.length || exporting}
                  onClick={() => void exportData(true)}
                >
                  <ArrowDownToLine size={13} />
                  导出 CSV
                </Button>
              }
            >
              <div className="chart-tabs">
                {(["cpu", "memory", "tps", "players"] as const).map((key) => (
                  <button
                    key={key}
                    className={kind === key ? "active" : ""}
                    onClick={() => setKind(key)}
                  >
                    {metricNames[key]}
                  </button>
                ))}
              </div>
              {metricSummary.count ? (
                <Chart metrics={metrics} kind={kind} height={260} interactive />
              ) : (
                <Empty
                  icon={BarChart3}
                  title={
                    history.loading ? "正在读取采样" : "此窗口没有可用样本"
                  }
                  description={
                    kind === "tps" && !snapshot?.capabilities.tps
                      ? "当前核心不提供 TPS，不以其他指标推算。"
                      : "尝试其他时间范围或检查后台连接。"
                  }
                />
              )}
              <div className="analysis-chart-footer">
                <span>最低 {format(metricSummary.min, kind)}</span>
                <span>样本 P95 {format(metricSummary.p95, kind)}</span>
                <span>最高 {format(metricSummary.max, kind)}</span>
              </div>
            </Panel>
            <Panel
              title="观察范围"
              subtitle="明确数据来源，避免误读"
              className="analysis-scope"
            >
              <dl className="scope-facts">
                <div>
                  <dt>性能窗口</dt>
                  <dd>{windowLabel}</dd>
                </div>
                <div>
                  <dt>首个时间点</dt>
                  <dd>{date(metrics[0]?.at)}</dd>
                </div>
                <div>
                  <dt>最近时间点</dt>
                  <dd>{date(metrics.at(-1)?.at)}</dd>
                </div>
                <div>
                  <dt>窗口缓存日志</dt>
                  <dd>{analysis.logs.total} 行</dd>
                </div>
                <div>
                  <dt>窗口返回任务</dt>
                  <dd>{analysis.jobs.total} 项</dd>
                </div>
              </dl>
              <p>
                性能历史已由后台分桶聚合；均值和 P95
                基于这些样本。人数曲线采用每桶观察峰值。缺失指标保持为空。
              </p>
              <p>
                日志与任务受后台保留数量限制，不能代表整个时间窗口。此页不会自动检测线路、发送命令或修改配置。
              </p>
            </Panel>
          </div>
        </section>
        {tab === "findings" && (
          <Panel className="findings-panel">
            {analysis.findings.length ? (
              analysis.findings.map((f) => (
                <div className={`finding-row ${f.tone}`} key={f.code}>
                  {f.tone === "warn" ? (
                    <TriangleAlert size={18} />
                  ) : (
                    <Activity size={18} />
                  )}
                  <div>
                    <strong>{f.title}</strong>
                    <p>{f.detail}</p>
                  </div>
                  <Button variant="ghost" onClick={() => navigate(f.page)}>
                    查看
                    <ArrowRight size={14} />
                  </Button>
                </div>
              ))
            ) : (
              <Empty
                icon={CheckCircle2}
                title="当前规则未发现需要提醒的项目"
                description="这不是全面健康认证；请结合采样范围、玩家反馈和实际业务状态判断。"
              />
            )}
          </Panel>
        )}
        {tab === "logs" && (
          <Panel
            title="警告与错误模式"
            subtitle={`缓存中 INFO ${analysis.logs.counts.INFO} · WARN ${analysis.logs.counts.WARN} · ERROR ${analysis.logs.counts.ERROR} · DEBUG ${analysis.logs.counts.DEBUG}`}
            aside={
              <Button onClick={() => navigate("console")}>
                打开控制台
                <ArrowRight size={14} />
              </Button>
            }
          >
            {analysis.logs.groups.length ? (
              <div className="log-pattern-list">
                {analysis.logs.groups.map((group) => (
                  <div key={group.key}>
                    <div>
                      <Badge tone={group.level === "ERROR" ? "red" : "amber"}>
                        {group.level}
                      </Badge>
                      <strong>{group.count} 次</strong>
                      <time>{date(group.lastAt)}</time>
                    </div>
                    <code>{group.sample}</code>
                    <p>{group.hint}</p>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                icon={FileText}
                title="此窗口的缓存中没有警告或错误"
                description="仅分析当前可读取的记录；不是全量日志扫描。"
              />
            )}
          </Panel>
        )}
        {tab === "operations" && (
          <div className="analysis-operations-grid">
            <Panel title="任务与备份" subtitle="仅汇总当前实例已有记录">
              <dl className="scope-facts">
                <div>
                  <dt>返回的窗口任务</dt>
                  <dd>{analysis.jobs.total} 项</dd>
                </div>
                <div>
                  <dt>失败 / 中断</dt>
                  <dd>{analysis.jobs.failed} 项</dd>
                </div>
                <div>
                  <dt>已结束任务成功率</dt>
                  <dd>
                    {analysis.jobs.successRate === null
                      ? "—"
                      : `${analysis.jobs.successRate.toFixed(1)}%`}
                  </dd>
                </div>
                <div>
                  <dt>登记备份</dt>
                  <dd>
                    {backups.data
                      ? `${analysis.backups.count} 份`
                      : "读取中 / 不可用"}
                  </dd>
                </div>
                <div>
                  <dt>最近备份</dt>
                  <dd>{date(analysis.backups.latestAt ?? undefined)}</dd>
                </div>
              </dl>
              <div className="panel-actions">
                <Button onClick={() => navigate("tasks")}>任务与记录</Button>
                <Button onClick={() => navigate("backups")}>备份与恢复</Button>
              </div>
            </Panel>
            <Panel
              title="玩家入口观察"
              subtitle="进程状态与传输检测分别展示"
              aside={
                <Button variant="ghost" onClick={() => navigate("network")}>
                  管理入口
                  <ArrowRight size={14} />
                </Button>
              }
            >
              {routes.length ? (
                <div className="analysis-route-list">
                  {routes.map((route) => (
                    <div key={route.key}>
                      <div>
                        <strong>{route.name}</strong>
                        <small>
                          {route.kind === "direct" ? "本机 IPv6" : "隧道入口"} ·{" "}
                          {route.running ? "进程就绪" : "进程待检查"}
                        </small>
                      </div>
                      <Badge
                        tone={
                          route.transport === "pass"
                            ? "green"
                            : route.transport === "fail"
                              ? "red"
                              : "neutral"
                        }
                      >
                        {transportLabel[route.transport]}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title={
                    network.loading || direct.loading
                      ? "正在读取入口"
                      : "尚无可展示的入口"
                  }
                />
              )}
              <p className="analysis-disclaimer">
                不会自动执行线路检测。握手通过不代表外网入站和真实账号已进世界。
              </p>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
