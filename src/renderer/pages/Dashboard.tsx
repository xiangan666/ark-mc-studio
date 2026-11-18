import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Archive,
  Box,
  BarChart3,
  ChevronRight,
  Cpu,
  Globe2,
  HardDrive,
  MemoryStick,
  Terminal,
  Users,
} from "lucide-react";
import type {
  Core,
  Metric,
  Route,
  RouteQualityReport,
} from "../../shared/types";
import type { DirectRouteStatus } from "../../shared/direct";
import {
  metricSeries,
  routeRows,
  summarizeMetric,
  transportLabel,
  metricChartPoints,
  type MetricKind,
} from "../analysis";
import InstanceBrief from "./InstanceBrief";
import CoreUpdates from "./CoreUpdates";
import { act, bytes, date, duration, useApp } from "../store";
import {
  Badge,
  Button,
  Chart,
  Empty,
  Heading,
  Panel,
  PageTabs,
  QueryError,
  Status,
  tabPanelProps,
  useQuery,
} from "../components";
export default function Dashboard({
  onUpdate,
}: {
  onUpdate: (version?: string, core?: Core) => void;
}) {
  const { data, selected, navigate } = useApp(
    useShallow((s) => ({
      data: s.data,
      selected: s.selected,
      navigate: s.navigate,
    })),
  );
  const instance = data!.instances.find((i) => i.id === selected)!;
  const snap = data!.snapshots.find((s) => s.id === selected);
  const [metric, setMetric] = useState<"cpu" | "memory" | "tps" | "players">(
    "cpu",
  );
  const [hours, setHours] = useState(1);
  const history = useQuery<Metric[]>(
    "metrics.history",
    { id: selected, hours },
    15000,
  );
  const network = useQuery<{ routes: Route[] }>(
    "tunnels.get",
    { id: selected },
    10000,
  );
  const direct = useQuery<DirectRouteStatus>(
    "direct.get",
    { id: selected },
    15000,
  );
  const quality = useQuery<RouteQualityReport | null>(
    "tunnels.quality.get",
    { id: selected },
    15000,
  );
  const routes = routeRows(
    network.data?.routes || [],
    direct.data,
    quality.data,
  );
  const routeError = network.error || direct.error || quality.error;
  const routeState = routeError
    ? "error"
    : !network.updatedAt || !direct.updatedAt || !quality.updatedAt
      ? "pending"
      : "ready";
  const retryRoutes = () => {
    network.reload();
    direct.reload();
    quality.reload();
  };
  const metrics = useMemo(
    () => metricSeries(history.data || [], snap?.metric, hours),
    [history.data, snap?.metric, hours],
  );
  const stats = summarizeMetric(
    metricSeries(history.data || [], undefined, hours),
    metric,
  );
  const statValue = (value: number | null) =>
    value === null
      ? "—"
      : metric === "memory"
        ? bytes(value)
        : metric === "cpu"
          ? `${value.toFixed(1)}%`
          : value.toFixed(metric === "players" ? 1 : 2);
  const activities = data!.activities
    .filter((a) => a.instanceId === selected)
    .slice(0, 5);
  const focusTarget = useApp((s) => s.focusTarget);
  const navigationKey = useApp((s) => s.navigationKey);
  const [section, setSection] = useState<"runtime" | "maintenance">("runtime");
  useEffect(() => {
    if (focusTarget === "core-updates") setSection("maintenance");
  }, [focusTarget, navigationKey]);
  const kpis = [
    {
      label: "在线玩家",
      value: snap?.metric.players ?? "—",
      unit: `/ ${snap?.maxPlayers || "—"}`,
      icon: Users,
      color: "amber",
      note: snap?.pid ? "共享世界 · 实时连接" : "等待服务器启动",
      kind: "players",
    },
    {
      label: "服务器 TPS",
      value: snap?.metric.tps?.toFixed(2) ?? "—",
      unit: "/ 20",
      icon: Activity,
      color: "blue",
      note: snap?.capabilities.tps
        ? "Endstone 实际采样"
        : "当前核心不提供此指标",
      kind: "tps",
    },
    {
      label: "CPU 使用率",
      value: snap?.metric.cpu?.toFixed(1) ?? "—",
      unit: "%",
      icon: Cpu,
      color: "green",
      note: "服务端进程 · 全机容量占比",
      kind: "cpu",
    },
    {
      label: "内存占用",
      value:
        snap?.metric.memory != null
          ? (snap.metric.memory / 1024 ** 3).toFixed(2)
          : "—",
      unit: "GB",
      icon: MemoryStick,
      color: "purple",
      note: "服务端进程工作集",
      kind: "memory",
    },
  ] as const;
  return (
    <div className="page overview-page">
      <Heading
        title="服务器总览"
        actions={
          <>
            <Button onClick={() => navigate("analysis")}>
              <BarChart3 size={15} />
              运行分析
            </Button>
            <Button variant="primary" onClick={() => navigate("console")}>
              <Terminal size={15} />
              打开控制台
            </Button>
          </>
        }
      />
      <PageTabs
        id="overview"
        label="总览功能分区"
        value={section}
        onChange={setSection}
        items={[
          { value: "runtime", label: "运行概况" },
          { value: "maintenance", label: "核心维护" },
        ]}
      />
      <section
        {...tabPanelProps("overview", "runtime")}
        className="overview-runtime"
        hidden={section !== "runtime"}
        aria-label="服务器运行概况"
      >
        <div className="instance-summary-band">
          <section
            className="world-hero server-summary"
            aria-label="当前世界资料"
          >
            <div className="server-summary-identity">
              <span className="server-summary-icon">
                <Box size={24} />
              </span>
              <div>
                <div className="world-identity">
                  <h2>{snap?.world || instance.name}</h2>
                  <Status status={snap?.status || "unknown"} />
                </div>
                <p>
                  {instance.core === "endstone"
                    ? "Endstone " + (snap?.endstoneVersion || "")
                    : "官方 BDS"}{" "}
                  · Bedrock {snap?.version || "未读取"}
                </p>
              </div>
            </div>
            <dl>
              <div>
                <dt>传输</dt>
                <dd>
                  {snap?.transport === "nethernet"
                    ? "NetherNet"
                    : snap?.transport === "raknet"
                      ? "RakNet"
                      : snap?.transport || "—"}{" "}
                  · {snap?.port ?? "—"}
                </dd>
              </div>
              <div>
                <dt>运行时长</dt>
                <dd>
                  {snap?.pid && snap.startedAt
                    ? duration((Date.now() - snap.startedAt) / 1000)
                    : snap?.status === "stopped"
                      ? "尚未启动"
                      : "—"}
                </dd>
              </div>
            </dl>
            <Button onClick={() => navigate("worlds")}>
              管理世界
              <ArrowRight size={14} />
            </Button>
          </section>
          <InstanceBrief
            id={selected}
            data={data!}
            routes={routes}
            routeState={routeState}
          />
        </div>
        <div className="kpi-grid">
          {kpis.map((k) => (
            <button
              className={`kpi-card ${k.color} ${metric === k.kind ? "selected" : ""}`}
              key={k.label}
              onClick={() => setMetric(k.kind)}
              aria-pressed={metric === k.kind}
            >
              <div className="kpi-label">
                <span>{k.label}</span>
                <div className="kpi-icon">
                  <k.icon size={18} />
                </div>
              </div>
              <div className="kpi-value">
                {k.value}
                <span>{k.unit}</span>
              </div>
              <div className="kpi-bottom">
                <span>{k.note}</span>
                <Spark metrics={metrics} field={k.kind} />
              </div>
            </button>
          ))}
        </div>
        <div className="overview-observation-bar">
          <span>
            <span className={`small-dot ${snap?.pid ? "green" : ""}`} />
            最近采样 {date(snap?.metric.at)}
          </span>
          <span>
            {routeState === "ready"
              ? routes.length +
                " 条玩家入口 · " +
                routes.filter((r) => r.running).length +
                " 条进程就绪"
              : routeState === "error"
                ? "线路状态未确认"
                : "正在读取线路"}
          </span>
          <button className="text-button" onClick={() => navigate("analysis")}>
            查看趋势与问题观察
            <ArrowRight size={13} />
          </button>
        </div>
        <div className="dashboard-middle">
          <Panel
            title="服务器性能"
            subtitle="实际进程数据与核心采样"
            aside={
              <select
                className="compact-select"
                aria-label="总览性能时间范围"
                value={hours}
                onChange={(e) => setHours(+e.target.value)}
              >
                <option value={1}>最近 1 小时</option>
                <option value={6}>最近 6 小时</option>
                <option value={24}>最近 24 小时</option>
              </select>
            }
          >
            <div className="chart-tabs">
              {(["cpu", "memory", "tps", "players"] as const).map((k) => (
                <button
                  className={metric === k ? "active" : ""}
                  aria-pressed={metric === k}
                  key={k}
                  onClick={() => setMetric(k)}
                >
                  {
                    (
                      {
                        cpu: "CPU",
                        memory: "内存",
                        tps: "TPS",
                        players: "玩家",
                      } as const
                    )[k]
                  }
                  <span>
                    {k === "cpu"
                      ? snap?.metric.cpu != null
                        ? snap.metric.cpu.toFixed(1) + "%"
                        : "—"
                      : k === "memory"
                        ? bytes(snap?.metric.memory)
                        : k === "tps"
                          ? snap?.metric.tps?.toFixed(2) || "—"
                          : (snap?.metric.players ?? "—")}
                  </span>
                </button>
              ))}
            </div>
            {history.error && (
              <QueryError error={history.error} retry={history.reload} />
            )}
            {metrics.some((m) => m[metric] !== null) ? (
              <Chart metrics={metrics} kind={metric} height={210} interactive />
            ) : (
              <div className="no-metric">
                <Activity size={22} />
                <strong>
                  {history.loading ? "正在读取性能样本" : "此时段暂无有效样本"}
                </strong>
              </div>
            )}
            <div className="metric-stat-strip">
              <span>
                样本均值 <strong>{statValue(stats.average)}</strong>
              </span>
              <span>
                峰值 <strong>{statValue(stats.max)}</strong>
              </span>
              <span>
                样本 P95 <strong>{statValue(stats.p95)}</strong>
              </span>
            </div>
            <div className="chart-foot">
              <span className="small-dot green" />
              系统指标约每 2 秒采样 · TPS 约每 15 秒采样
              <span>MSPT {snap?.metric.mspt?.toFixed(2) ?? "—"} ms</span>
            </div>
          </Panel>
          <Panel
            title="公网线路"
            subtitle="独立入口，通向同一个世界"
            aside={<IconLink onClick={() => navigate("network")} />}
          >
            {routeError && (
              <QueryError error={routeError} retry={retryRoutes} />
            )}
            {routes.length ? (
              <div className="route-summary-list">
                {routes.map((r, index) => (
                  <button
                    className="route-summary"
                    key={r.key}
                    onClick={() => navigate("network", `route-${r.key}`)}
                  >
                    <div
                      className={`route-icon ${index % 2 ? "purple" : "green"}`}
                    >
                      <Globe2 size={16} />
                    </div>
                    <div>
                      <strong>{r.name}</strong>
                      <small>{r.address}</small>
                    </div>
                    <Badge tone={r.running ? "green" : "amber"}>
                      {r.running ? "进程就绪" : "待检查"}
                    </Badge>
                    <span className="route-summary-transport">
                      {transportLabel[r.transport]}
                    </span>
                  </button>
                ))}
                <div className="route-summary-note">
                  <Globe2 size={15} />
                  <span>
                    按玩家填写的入口选线路
                    <br />
                    <small>信令与 UDP 分别检查</small>
                  </span>
                </div>
              </div>
            ) : routeState === "error" ? null : routeState === "pending" ? (
              <div className="route-pending" role="status">
                正在读取玩家入口…
              </div>
            ) : (
              <Empty
                icon={Globe2}
                title="还没有关联线路"
                description="此实例尚未配置隧道或原生 IPv6 入口。"
                action={
                  <Button onClick={() => navigate("network")}>配置网络</Button>
                }
              />
            )}
          </Panel>
        </div>

        <div className="dashboard-bottom">
          <Panel
            title="最近活动"
            aside={
              <button
                className="text-button"
                onClick={() => navigate("players")}
              >
                玩家管理
                <ChevronRight size={14} />
              </button>
            }
          >
            {activities.length ? (
              <div className="activity-list">
                {activities.map((a, index) => (
                  <div key={a.id}>
                    <span className={`activity-dot ${a.level}`} />
                    <div>
                      <p>{a.text}</p>
                      <small>{date(a.at)}</small>
                    </div>
                    {index === 0 && <Badge>最新</Badge>}
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="等待新的冒险"
                description="玩家进出与管理操作会记录在这里。"
              />
            )}
          </Panel>
          <Panel title="常用操作">
            <div className="quick-grid">
              {[
                {
                  icon: Archive,
                  label: "备份世界",
                  note: "保存此刻的进度",
                  action: () =>
                    void act(
                      "backups.create",
                      { id: selected, kind: "world" },
                      "世界备份已排队",
                    ),
                },
                {
                  icon: Box,
                  label: "模组与插件",
                  note: "行为包、资源包与插件",
                  action: () => navigate("packs"),
                },
                {
                  icon: Globe2,
                  label: "线路诊断",
                  note: "检查各条公网入口",
                  action: () => navigate("network", "network-diagnostics"),
                },
                {
                  icon: HardDrive,
                  label: "核心维护",
                  note: "检查版本与更新策略",
                  action: () => setSection("maintenance"),
                },
              ].map((item) => (
                <button key={item.label} onClick={item.action}>
                  <span>
                    <item.icon size={18} />
                  </span>
                  <div>
                    <strong>{item.label}</strong>
                    <small>{item.note}</small>
                  </div>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </Panel>
        </div>
      </section>
      <section
        {...tabPanelProps("overview", "maintenance")}
        className="overview-maintenance"
        hidden={section !== "maintenance"}
        aria-label="服务器核心维护"
      >
        <CoreUpdates id={selected} key={selected} onUpdate={onUpdate} />
      </section>
    </div>
  );
}
function IconLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="icon-button"
      aria-label="查看网络与穿透"
      onClick={onClick}
    >
      <ArrowUpRight size={17} />
    </button>
  );
}
function Spark({ metrics, field }: { metrics: Metric[]; field: MetricKind }) {
  const points = metricChartPoints(metrics.slice(-25), field);
  const values = points.flatMap(([, v]) => (v === null ? [] : [v]));
  if (values.length < 2) return null;
  const low = Math.min(...values),
    high = Math.max(...values),
    first = points[0][0],
    span = points.at(-1)![0] - first;
  let move = true;
  const line = points
    .map(([at, v]) => {
      if (v === null) {
        move = true;
        return "";
      }
      const cmd = move ? "M" : "L";
      move = false;
      return (
        cmd +
        (((at - first) / (span || 1)) * 70 + 2) +
        " " +
        (high === low ? 12 : 22 - ((v - low) / (high - low)) * 20)
      );
    })
    .join(" ");
  return (
    <svg className="spark" viewBox="0 0 74 24" aria-hidden="true">
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
