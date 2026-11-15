import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import SignalRouterDialog, { createRouter, type Router } from "./SignalRouters";
import { backendReloadBlock } from "../../shared/backend";
import { safeResult } from "../editing";
import RouteQuality from "./RouteQuality";
import SignalHub, { signalStatus } from "./SignalHub";
import {
  networkSections,
  networkSectionForTarget,
  type NetworkSection,
} from "../network-navigation";
import { uniqueTunnelClients } from "../../shared/network";
import type { TunnelClientStatus } from "../../agent/tunnel-clients";
import DirectRoute from "./DirectRoute";
import NetworkOverview, {
  NetworkToolbar,
  selectRoutes,
  type RouteFilter,
} from "./NetworkOverview";
import { routeRows } from "../analysis";
import { readPreference } from "../navigation";
import type { DirectRouteStatus } from "../../shared/direct";
import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowRight,
  Box,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  FileCheck2,
  FileText,
  FolderOpen,
  Globe2,
  HardDrive,
  Layers,
  Link2,
  LoaderCircle,
  Moon,
  Network,
  Play,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Timer,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  Backup,
  Diagnostic,
  Instance,
  Job,
  Player,
  Route,
  RouteQualityReport,
  SignalRouterConfig,
  Schedule,
  Tunnel,
} from "../../shared/types";
import { act, bytes, date, duration, message, useApp } from "../store";
import {
  Badge,
  Button,
  Confirm,
  Disclosure,
  Drawer,
  Empty,
  Field,
  Heading,
  IconButton,
  Loading,
  Modal,
  Notice,
  Panel,
  PathInput,
  PageTabs,
  tabPanelProps,
  QueryError,
  SearchInput,
  Status,
  Toggle,
  Steps,
  useQuery,
} from "../components";

export function PlayersPage() {
  const id = useApp((s) => s.selected);
  const snapshot = useApp((s) => s.data?.snapshots.find((p) => p.id === id));
  const q = useQuery<{
    players: Player[];
    allowlist: any[];
    permissions: any[];
  }>("players.get", { id }, 10000);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("online");
  const [detailName, setDetailName] = useState("");
  const [removeAllow, setRemoveAllow] = useState("");
  const [add, setAdd] = useState(false);
  const [name, setName] = useState("");
  const [action, setAction] = useState<{
    player: Player;
    action: string;
  } | null>(null);
  const [reason, setReason] = useState("管理员操作");
  const players = snapshot?.players || q.data?.players || [];
  const detailPlayer = players.find((p) => p.name === detailName);
  const allowlist = (q.data?.allowlist || []).filter((p) =>
    (p.name + " " + p.xuid).toLowerCase().includes(search.toLowerCase()),
  );
  const shown = players.filter(
    (p) =>
      (tab !== "online" || p.online) &&
      (!search || p.name.toLowerCase().includes(search.toLowerCase())),
  );
  return (
    <div className="page">
      <Heading
        eyebrow="PEOPLE IN YOUR WORLD"
        title="玩家与权限"
        description="看看谁正在冒险，管理权限与允许名单。"
        actions={
          <>
            <Button onClick={() => setAdd(true)}>
              <UserPlus size={15} />
              添加允许玩家
            </Button>
            <Button
              variant="primary"
              onClick={() => useApp.getState().navigate("console")}
            >
              <Terminal size={15} />
              发送公告
            </Button>
          </>
        }
      />
      <div className="mini-stats">
        {[
          {
            label: "当前在线",
            value: players.filter((p) => p.online).length,
            icon: Users,
          },
          { label: "已记录玩家", value: players.length, icon: UserPlus },
          {
            label: "允许名单",
            value: q.data?.allowlist.length ?? "—",
            icon: ShieldCheck,
          },
          {
            label: "人数上限",
            value: snapshot?.maxPlayers ?? "—",
            icon: Server,
          },
        ].map((s) => (
          <Panel key={s.label}>
            <s.icon size={20} />
            <div>
              <strong>{s.value}</strong>
              <span>{s.label}</span>
            </div>
          </Panel>
        ))}
      </div>
      <div className="list-toolbar">
        <div className="segmented">
          <button
            className={tab === "all" ? "active" : ""}
            onClick={() => setTab("all")}
          >
            连接记录
          </button>
          <button
            className={tab === "online" ? "active" : ""}
            onClick={() => setTab("online")}
          >
            当前在线
          </button>
          <button
            className={tab === "allow" ? "active" : ""}
            onClick={() => setTab("allow")}
          >
            允许名单
          </button>
        </div>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索玩家名称…"
        />
      </div>
      {q.error && <QueryError error={q.error} retry={q.reload} />}
      <Panel>
        {tab === "allow" ? (
          allowlist.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>玩家</th>
                  <th>XUID</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {allowlist.map((p: any) => (
                  <tr key={p.name}>
                    <td>
                      <strong>{p.name}</strong>
                    </td>
                    <td className="mono muted">{p.xuid || "首次认证后记录"}</td>
                    <td>
                      <Button onClick={() => setRemoveAllow(p.name)}>
                        移出名单
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              icon={Shield}
              title="允许名单为空"
              description="允许名单开启后，只有名单中的玩家能够连接。"
            />
          )
        ) : shown.length ? (
          <table className="data-table player-table">
            <thead>
              <tr>
                <th>玩家</th>
                <th>状态</th>
                <th>已记录游戏时长</th>
                <th>最近活动</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.name}>
                  <td>
                    <div className="player-identity">
                      <div
                        className="player-avatar"
                        style={
                          {
                            "--avatar-hue": `${[...p.name].reduce((n, c) => n + c.charCodeAt(0), 0) % 360}`,
                          } as any
                        }
                      >
                        {p.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <strong>{p.name}</strong>
                        <small className="mono">
                          {p.xuid || "XUID 未记录"}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge tone={p.online ? "green" : "neutral"}>
                      <span className="status-dot" />
                      {p.online ? "在线" : "离线"}
                    </Badge>
                  </td>
                  <td>
                    {duration(
                      p.totalSeconds +
                        (p.online && p.joinedAt
                          ? (Date.now() - p.joinedAt) / 1000
                          : 0),
                    )}
                  </td>
                  <td className="muted">{date(p.lastSeen)}</td>
                  <td>
                    <Button onClick={() => setDetailName(p.name)}>
                      玩家详情
                      <ChevronRight size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={Users}
            title="暂时没有匹配的玩家"
            description="玩家连接后会根据服务端日志自动记录。"
          />
        )}
      </Panel>
      <Notice>
        游戏时长依据可读取的进出记录统计。离线身份验证模式下，管理员权限的持久性取决于服务端认证状态。
      </Notice>
      <Drawer
        open={!!detailName}
        onClose={() => setDetailName("")}
        title={detailName || "玩家详情"}
        description="连接记录、已记录游戏时长与权限操作"
      >
        {detailPlayer && (
          <>
            <Badge tone={detailPlayer.online ? "green" : "neutral"}>
              {detailPlayer.online ? "当前在线" : "离线"}
            </Badge>
            <dl className="detail-grid">
              <div>
                <dt>XUID</dt>
                <dd className="mono">{detailPlayer.xuid || "尚未记录"}</dd>
              </div>
              <div>
                <dt>权限记录</dt>
                <dd>
                  {q.data?.permissions.find((p) => p.xuid === detailPlayer.xuid)
                    ?.permission || "未单独设置"}
                </dd>
              </div>
              <div>
                <dt>最近活动</dt>
                <dd>{date(detailPlayer.lastSeen)}</dd>
              </div>
              <div>
                <dt>累计时长</dt>
                <dd>
                  {duration(
                    detailPlayer.totalSeconds +
                      (detailPlayer.online && detailPlayer.joinedAt
                        ? (Date.now() - detailPlayer.joinedAt) / 1000
                        : 0),
                  )}
                </dd>
              </div>
            </dl>
            <Panel title="玩家操作">
              <div className="drawer-actions">
                <Button
                  disabled={
                    !detailPlayer.online || !snapshot?.capabilities.command
                  }
                  onClick={() =>
                    setAction({ player: detailPlayer, action: "op" })
                  }
                >
                  设为管理员
                </Button>
                <Button
                  disabled={
                    !detailPlayer.online || !snapshot?.capabilities.command
                  }
                  onClick={() =>
                    setAction({ player: detailPlayer, action: "deop" })
                  }
                >
                  取消管理员
                </Button>
                <Button
                  variant="danger"
                  disabled={
                    !detailPlayer.online || !snapshot?.capabilities.command
                  }
                  onClick={() =>
                    setAction({ player: detailPlayer, action: "kick" })
                  }
                >
                  踢出玩家
                </Button>
              </div>
            </Panel>
            {(!detailPlayer.online || !snapshot?.capabilities.command) && (
              <Notice>
                权限命令和踢出操作需要玩家在线，且服务器由管理后台控制。
              </Notice>
            )}
            <Button
              onClick={() => {
                setName(detailPlayer.name);
                setAdd(true);
              }}
            >
              添加到允许名单
            </Button>
          </>
        )}
      </Drawer>
      <Confirm
        open={!!removeAllow}
        onClose={() => setRemoveAllow("")}
        title="移出允许名单"
        description={`将「${removeAllow}」移出名单；启用允许名单时，该玩家将无法再次加入。`}
        danger
        label="移出名单"
        onConfirm={async () => {
          await act(
            "players.action",
            { id, name: removeAllow, action: "allow-remove" },
            "允许名单已更新",
          );
          q.reload();
        }}
      />
      <Modal
        open={add}
        onClose={() => setAdd(false)}
        title="添加到允许名单"
        description="填写玩家的 Xbox Gamertag，空格会按完整名称处理。"
      >
        <Field label="玩家名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Example Player"
          />
        </Field>
        <div className="modal-actions">
          <Button onClick={() => setAdd(false)}>取消</Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              const result = await act(
                "players.action",
                { id, name: name.trim(), action: "allow-add" },
                "允许名单已更新",
              );
              if (result !== undefined) {
                setAdd(false);
                setName("");
                q.reload();
              }
            }}
          >
            添加玩家
          </Button>
        </div>
      </Modal>
      <Modal
        open={!!action}
        onClose={() => setAction(null)}
        title={
          action?.action === "kick"
            ? "踢出玩家"
            : action?.action === "op"
              ? "授予管理员权限"
              : "取消管理员权限"
        }
        description={`操作对象：${action?.player.name || ""}`}
      >
        {action?.action === "kick" ? (
          <Field label="显示给玩家的原因">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        ) : (
          <Notice tone="warn">这会修改玩家当前权限，请确认操作对象。</Notice>
        )}
        <div className="modal-actions">
          <Button onClick={() => setAction(null)}>取消</Button>
          <Button
            variant={action?.action === "kick" ? "danger" : "primary"}
            onClick={async () => {
              const result = await act(
                "players.action",
                {
                  id,
                  name: action?.player.name,
                  action: action?.action,
                  reason,
                },
                "命令已发送",
              );
              if (result !== undefined) setAction(null);
            }}
          >
            确认执行
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function BackupsPage() {
  const id = useApp((s) => s.selected);
  const jobs = useApp((s) => s.data?.jobs || []);
  const q = useQuery<Backup[]>("backups.list", { id });
  const [restore, setRestore] = useState<Backup | null>(null);
  const [remove, setRemove] = useState<Backup | null>(null);
  const [manifest, setManifest] = useState<any>(null);
  const [detail, setDetail] = useState<Backup | null>(null);
  const [kindFilter, setKindFilter] = useState("all");
  const [restoreJobId, setRestoreJobId] = useState("");
  const restoreJob = jobs.find((j) => j.id === restoreJobId);
  const [search, setSearch] = useState("");
  const backups = q.data || [];
  const shown = backups.filter(
    (b) =>
      (kindFilter === "all" ||
        (kindFilter === "verified" ? b.verified : b.kind === kindFilter)) &&
      `${b.name} ${b.world} ${b.version}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="page">
      <Heading
        eyebrow="EVERY ADVENTURE, PRESERVED"
        title="备份与恢复"
        description="创建恢复点、检查完整性，并安全恢复世界或整个实例。"
        actions={
          <>
            <Button
              onClick={() =>
                void act(
                  "backups.create",
                  { id, kind: "full" },
                  "完整快照任务已排队",
                )
              }
            >
              <Layers size={15} />
              完整实例快照
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                void act(
                  "backups.create",
                  { id, kind: "world" },
                  "世界备份任务已排队",
                )
              }
            >
              <Archive size={15} />
              立即备份世界
            </Button>
          </>
        }
      />
      <Notice>
        世界备份支持在线创建；完整实例快照会正常停服并按原状态重新启动。恢复前校验备份，并创建当前状态的保护快照。
      </Notice>
      <div className="mini-stats three">
        {[
          { label: "可用恢复点", value: backups.length, icon: Archive },
          {
            label: "备份总占用",
            value: bytes(backups.reduce((n, b) => n + b.size, 0)),
            icon: HardDrive,
          },
          { label: "最近一次备份", value: date(backups[0]?.at), icon: Clock3 },
        ].map((s) => (
          <Panel key={s.label}>
            <s.icon size={19} />
            <div>
              <strong
                className={s.label === "最近一次备份" ? "small-value" : ""}
              >
                {s.value}
              </strong>
              <span>{s.label}</span>
            </div>
          </Panel>
        ))}
      </div>
      <div className="list-toolbar">
        <div className="segmented">
          {[
            ["all", "全部恢复点"],
            ["world", "世界备份"],
            ["full", "完整快照"],
            ["verified", "已校验"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={kindFilter === key ? "active" : ""}
              onClick={() => setKindFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索世界或版本…"
        />
      </div>
      {q.error && <QueryError error={q.error} retry={q.reload} />}
      <Panel>
        {q.loading && !q.data ? (
          <Loading />
        ) : shown.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>恢复点</th>
                <th>文件与大小</th>
                <th>校验</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id}>
                  <td>
                    <div className="table-identity">
                      <span className="table-icon">
                        <Archive size={20} />
                      </span>
                      <div>
                        <strong>{b.name}</strong>
                        <small>
                          {date(b.at)} · {b.version}
                          {b.automatic ? " · 自动" : ""}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    {bytes(b.size)}
                    <small className="cell-sub">
                      {b.files.toLocaleString()} 个文件 ·{" "}
                      {b.kind === "world" ? "世界备份" : "完整快照"}
                    </small>
                  </td>
                  <td>
                    <Badge tone={b.verified ? "green" : "red"}>
                      {b.verified ? (
                        <CheckCircle2 size={12} />
                      ) : (
                        <TriangleAlert size={12} />
                      )}{" "}
                      {b.verified ? "已校验" : "需处理"}
                    </Badge>
                    <small className="cell-sub mono">
                      {b.sha256.slice(0, 12)}…
                    </small>
                  </td>
                  <td>
                    <div className="inline-actions">
                      <Button
                        onClick={() => {
                          setRestoreJobId("");
                          setRestore(b);
                        }}
                      >
                        恢复
                      </Button>
                      <IconButton
                        label="查看文件清单"
                        onClick={async () => {
                          setDetail(b);
                          setManifest(null);
                          const result = await act("backups.manifest", {
                            backupId: b.id,
                          });
                          if (result) setManifest(result);
                        }}
                      >
                        <FileText size={16} />
                      </IconButton>
                      <IconButton
                        label="重新校验"
                        onClick={() =>
                          void act(
                            "backups.verify",
                            { backupId: b.id },
                            "完整性校验已排队",
                          )
                        }
                      >
                        <FileCheck2 size={16} />
                      </IconButton>
                      <IconButton
                        label="打开备份文件位置"
                        onClick={async () => {
                          const file = await act<string>("backups.path", {
                            backupId: b.id,
                          });
                          if (file) await window.ark.reveal(file);
                        }}
                      >
                        <FolderOpen size={16} />
                      </IconButton>
                      <IconButton label="删除备份" onClick={() => setRemove(b)}>
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={Archive}
            title="还没有备份"
            description="创建第一份世界备份，把当前的冒险安全保存下来。"
            action={
              <Button
                variant="primary"
                onClick={() =>
                  void act(
                    "backups.create",
                    { id, kind: "world" },
                    "世界备份已排队",
                  )
                }
              >
                创建世界备份
              </Button>
            }
          />
        )}
      </Panel>
      <Drawer
        open={!!restore}
        onClose={() => setRestore(null)}
        title="恢复备份"
        description={`${restore?.name || ""} · ${date(restore?.at)}`}
      >
        <Steps
          items={["校验", "保护快照", "恢复", "结果"]}
          current={
            !restoreJob
              ? 0
              : restoreJob.status === "success"
                ? 3
                : /恢复文件|解压|切换/.test(restoreJob.detail)
                  ? 2
                  : /快照|停服/.test(restoreJob.detail)
                    ? 1
                    : 0
          }
        />
        {restoreJob ? (
          <>
            <JobProgress job={restoreJob} />
            <Notice
              tone={
                restoreJob.status === "failed"
                  ? "warn"
                  : restoreJob.status === "success"
                    ? "success"
                    : "info"
              }
            >
              {restoreJob.status === "success"
                ? "恢复任务已完成，结果以后台检查为准。"
                : restoreJob.status === "failed"
                  ? restoreJob.detail
                  : "后台正在执行恢复；关闭详情后任务仍继续。"}
            </Notice>
            <Button onClick={() => useApp.getState().navigate("tasks")}>
              查看任务与记录
              <ChevronRight size={14} />
            </Button>
          </>
        ) : (
          <>
            <Notice tone="warn">
              当前世界将回到备份时刻。程序先校验备份，再正常关服、创建恢复前完整快照，随后恢复文件并检查结果。
            </Notice>
            <dl className="detail-grid">
              <div>
                <dt>世界</dt>
                <dd>{restore?.world}</dd>
              </div>
              <div>
                <dt>核心版本</dt>
                <dd>{restore?.version}</dd>
              </div>
              <div>
                <dt>类型</dt>
                <dd>
                  {restore?.kind === "full" ? "完整实例快照" : "世界备份"}
                </dd>
              </div>
              <div>
                <dt>备份校验</dt>
                <dd>
                  {restore?.verified ? "已校验，恢复时再次验证" : "需重新校验"}
                </dd>
              </div>
            </dl>
            <div className="modal-actions">
              <Button onClick={() => setRestore(null)}>取消</Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const job = await act<Job>(
                    "backups.restore",
                    { backupId: restore?.id },
                    "恢复任务已排队",
                  );
                  if (job) setRestoreJobId(job.id);
                }}
              >
                创建保护快照并恢复
              </Button>
            </div>
          </>
        )}
      </Drawer>
      <Confirm
        open={!!remove}
        onClose={() => setRemove(null)}
        title="删除备份"
        description={`将删除「${remove?.name}」对应的压缩包。请确认保留了需要的恢复点。`}
        danger
        label="删除此备份"
        onConfirm={async () => {
          await act("backups.remove", { backupId: remove?.id }, "备份已删除");
          q.reload();
        }}
      />
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title="备份详情与文件清单"
        description={`${detail?.world || ""} · ${detail?.version || ""}`}
        wide
      >
        {detail && (
          <>
            <dl className="detail-grid">
              <div>
                <dt>创建时间</dt>
                <dd>{date(detail.at)}</dd>
              </div>
              <div>
                <dt>类型与校验</dt>
                <dd>
                  {detail.kind === "world" ? "世界备份" : "完整快照"} ·{" "}
                  {detail.verified ? "已校验" : "需处理"}
                </dd>
              </div>
              <div>
                <dt>文件与占用</dt>
                <dd>
                  {detail.files} 个文件 · {bytes(detail.size)}
                </dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd className="mono">{detail.sha256}</dd>
              </div>
            </dl>
            <div className="drawer-actions">
              <Button
                onClick={() =>
                  void act(
                    "backups.verify",
                    { backupId: detail.id },
                    "校验任务已排队",
                  )
                }
              >
                <FileCheck2 size={15} />
                重新校验
              </Button>
              <Button
                onClick={async () => {
                  const file = await act<string>("backups.path", {
                    backupId: detail.id,
                  });
                  if (file) await window.ark.reveal(file);
                }}
              >
                <FolderOpen size={15} />
                文件位置
              </Button>
              <Button variant="danger" onClick={() => setRemove(detail)}>
                删除
              </Button>
            </div>
            {manifest ? (
              <BackupManifest files={manifest.files || []} />
            ) : (
              <div className="detail-note">
                文件清单读取中；读取失败会显示通知，可重新打开详情重试。
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}

function BackupManifest({
  files,
}: {
  files: { path: string; size: number }[];
}) {
  const [search, setSearch] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const shown = useMemo(
    () =>
      files.filter((f) => f.path.toLowerCase().includes(search.toLowerCase())),
    [files, search],
  );
  const virtual = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 38,
    overscan: 10,
  });
  return (
    <div className="manifest-browser">
      <div className="list-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索备份文件…"
        />
        <Badge>{shown.length} 个文件</Badge>
      </div>
      <div
        className="manifest-list"
        ref={scroll}
        style={{ height: 360, overflow: "auto" }}
      >
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((row) => {
            const f = shown[row.index];
            return (
              <div
                key={f.path}
                style={{
                  position: "absolute",
                  height: 38,
                  top: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <FileText size={14} />
                <span title={f.path}>{f.path}</span>
                <small>{bytes(f.size)}</small>
              </div>
            );
          })}
        </div>
        {!shown.length && <Empty title="没有匹配的文件" />}
      </div>
    </div>
  );
}

interface NetworkData {
  attached: boolean;
  tunnels: Tunnel[];
  routes: Route[];
  interfaces: string[];
  routerHealthy: boolean;
  routers?: Router[];
  clients?: TunnelClientStatus[];
  endpoint?: { publicUdpIP?: string; publicUdpPort?: number };
}
export function NetworkPage() {
  const id = useApp((s) => s.selected);
  const q = useQuery<NetworkData>("tunnels.get", { id }, 8000);
  const direct = useQuery<DirectRouteStatus>("direct.get", { id }, 8000);
  const quality = useQuery<RouteQualityReport | null>(
    "tunnels.quality.get",
    { id },
    5000,
  );
  const jobs = useApp((s) => s.data?.jobs || []);
  const snapshot = useApp((s) => s.data?.snapshots.find((v) => v.id === id));
  const [routerEdit, setRouterEdit] = useState<SignalRouterConfig | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [routeSearch, setRouteSearch] = useState("");
  const [routeFilter, setRouteFilter] = useState<RouteFilter>("all");
  const [routeView, setRouteView] = useState<"cards" | "overview">(() =>
    readPreference<string>("ark.routes-view", "cards") === "overview"
      ? "overview"
      : "cards",
  );
  const focusTarget = useApp((s) => s.focusTarget);
  const navigationKey = useApp((s) => s.navigationKey);
  const [section, setSection] = useState<NetworkSection>("routes");

  useEffect(() => {
    const targetSection = networkSectionForTarget(focusTarget);
    if (targetSection) setSection(targetSection);
    if (targetSection === "routes") {
      setRouteView("cards");
      setRouteSearch("");
      setRouteFilter("all");
    }
  }, [focusTarget, navigationKey]);
  const [routeActionPending, setRouteActionPending] = useState(false);
  const qualityJob = jobs.find(
    (j) =>
      j.instanceId === id &&
      j.type === "route-quality" &&
      ["queued", "running"].includes(j.status),
  );
  const tunnelBusy =
    routeActionPending ||
    jobs.some(
      (j) =>
        j.instanceId === id &&
        j.type === "tunnel" &&
        ["queued", "running"].includes(j.status),
    );
  const [importing, setImporting] = useState(false);
  const [tunnelId, setTunnelId] = useState("");
  const [token, setToken] = useState("");
  const [provider, setProvider] = useState<"lolia" | "sakura">("lolia");
  const [log, setLog] = useState<{ id: number; text: string } | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [target, setTarget] = useState<Tunnel | null>(null);
  const [ip, setIP] = useState("");
  const routes = q.data?.routes || [];
  const allRows = routeRows(routes, direct.data, quality.data);
  const visibleRows = selectRoutes(allRows, routeSearch, routeFilter);
  const visibleKeys = new Set(visibleRows.map((row) => row.key));
  const changeView = (view: "cards" | "overview") => {
    setRouteView(view);
    localStorage.setItem("ark.routes-view", JSON.stringify(view));
  };
  const manageRoute = (key: string) => {
    setSection("routes");
    changeView("cards");
    setRouteSearch("");
    setRouteFilter("all");
    setTimeout(() => {
      const card = document.getElementById(`route-${key}`);
      const main = document.querySelector("main");
      if (card && main) {
        main.scrollTo({
          top:
            main.scrollTop +
            card.getBoundingClientRect().top -
            main.getBoundingClientRect().top -
            18,
          behavior: "smooth",
        });
        card
          .querySelector<HTMLElement>("button")
          ?.focus({ preventScroll: true });
      }
    }, 60);
  };
  const udpOnlyTunnels = (q.data?.tunnels || []).filter(
    (t) => t.type === "udp" && !routes.some((route) => route.udpId === t.id),
  );
  const diag = jobs.find((j) => j.id === diagnostic);
  async function measure(signalId?: number) {
    setMeasuring(true);
    try {
      await act<Job>("tunnels.quality", { id, signalId }, "线路质量检测已排队");
    } finally {
      setMeasuring(false);
    }
  }
  async function routeAction(
    signalId: number,
    action: "start" | "stop" | "reload",
  ) {
    setRouteActionPending(true);
    try {
      await act(
        "tunnels.action",
        { id, tunnelId: signalId, action },
        "信令与转接层操作已排队",
      );
    } finally {
      setRouteActionPending(false);
    }
  }
  async function attach() {
    const root = await window.ark.chooseDirectory();
    if (root && (await act("tunnels.attach", { id, root }, "已关联客户端目录")))
      q.reload();
  }
  const editRouter = (route: Route) =>
    setRouterEdit(
      q.data?.routers?.find((r) => r.signalId === route.signalId) ||
        createRouter(
          route,
          q.data?.routers || [],
          q.data?.endpoint,
          snapshot?.port || 19132,
        ),
    );
  async function diagnose(route: Route, advanced = false) {
    const job = await act<Job>("tunnels.diagnose", {
      id,
      host: route.host,
      advanced,
    });
    if (job) setDiagnostic(job.id);
  }
  return (
    <div className="page network-page">
      <Heading
        eyebrow="CONNECTED, EVERYWHERE"
        title="网络线路"
        description="统一管理信令转接与穿透工具，多条线路接入同一个世界。"
        actions={
          <>
            <Button onClick={() => void attach()}>
              <FolderOpen size={15} />
              迁移已有客户端
            </Button>
            <Button variant="primary" onClick={() => setImporting(true)}>
              <Plus size={15} />
              导入隧道
            </Button>
          </>
        }
      />
      {q.error && <QueryError error={q.error} retry={q.reload} />}
      <div className="network-summary summary-line">
        <span>
          <strong>{allRows.length}</strong> 个玩家入口
        </span>
        <span>
          <span className="small-dot green" />
          <strong>{allRows.filter((row) => row.running).length}</strong>{" "}
          个进程就绪
        </span>
        <span>
          <strong>
            {allRows.filter((row) => row.transport === "pass").length}
          </strong>{" "}
          个近期握手通过
        </span>
        <small>进程状态与实际连接结果分别记录</small>
      </div>
      <PageTabs
        id="network"
        label="网络功能分区"
        value={section}
        onChange={setSection}
        items={networkSections}
      />
      <section
        {...tabPanelProps("network", "signals")}
        className="network-view"
        hidden={section !== "signals"}
        aria-label="信令转接工作区"
      >
        {routes.length ? (
          <SignalHub
            key={id}
            id={id}
            routes={routes}
            tunnels={q.data?.tunnels || []}
            routers={q.data?.routers || []}
            clients={q.data?.clients || []}
            busy={tunnelBusy}
            onEdit={editRouter}
            onAction={(signalId, action) => void routeAction(signalId, action)}
            onSaved={q.reload}
          />
        ) : (
          <Empty
            icon={Link2}
            title="尚无可转接的信令入口"
            description="先导入或关联隧道，再为每条信令选择对应的 UDP 映射。"
          />
        )}
      </section>
      <section
        {...tabPanelProps("network", "routes")}
        className="network-view"
        hidden={section !== "routes"}
        aria-label="玩家入口工作区"
      >
        {direct.error && (
          <QueryError error={direct.error} retry={direct.reload} />
        )}
        {!!allRows.length && (
          <>
            <NetworkToolbar
              rows={visibleRows}
              search={routeSearch}
              onSearch={setRouteSearch}
              filter={routeFilter}
              onFilter={setRouteFilter}
              view={routeView}
              onView={changeView}
            />
            {routeView === "overview" && (
              <NetworkOverview rows={visibleRows} onManage={manageRoute} />
            )}
          </>
        )}
        {routes.length || direct.data?.configured ? (
          <div
            className="routes-grid"
            id="network-routes"
            hidden={routeView === "overview"}
          >
            {visibleKeys.has("direct") && (
              <DirectRoute key={id} id={id} query={direct} />
            )}
            {routes
              .filter((r) => visibleKeys.has(`tunnel-${r.signalId}`))
              .map((r, index) => {
                const router = q.data?.routers?.find(
                  (item) => item.signalId === r.signalId,
                );
                return (
                  <Panel
                    id={`route-tunnel-${r.signalId}`}
                    className={`route-card route-${index % 2 ? "purple" : "green"}`}
                    key={r.signalId}
                  >
                    <div className="route-card-top">
                      <div
                        className={`route-icon ${index % 2 ? "purple" : "green"}`}
                      >
                        <Globe2 size={19} />
                      </div>
                      <div>
                        <h3>{r.name}</h3>
                        <small>
                          {
                            q.data?.tunnels.find((t) => t.id === r.signalId)
                              ?.node
                          }
                        </small>
                      </div>
                      <Badge tone={signalStatus(r, router).tone}>
                        <span className="status-dot" />
                        {signalStatus(r, router).label}
                      </Badge>
                    </div>
                    <div className="public-address">
                      <span>玩家连接地址</span>
                      <div>
                        <strong>{r.host}</strong>
                        <code>{r.port}</code>
                        <IconButton
                          label="复制玩家连接信息"
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(`${r.host}:${r.port}`)
                              .then(() =>
                                useApp.getState().toast("连接信息已复制"),
                              )
                          }
                        >
                          <Copy size={15} />
                        </IconButton>
                      </div>
                      <small>在游戏中分别填写地址与端口，无需 https://</small>
                    </div>
                    <Disclosure title="连接路径与隧道参数">
                      <div className="route-chain">
                        <div>
                          <span>
                            <Globe2 size={15} />
                          </span>
                          <strong>公网入口</strong>
                          <small>
                            {(r.protocol || "https").toUpperCase()} :{r.port}
                          </small>
                        </div>
                        <i />
                        <div>
                          <span>
                            <Link2 size={15} />
                          </span>
                          <strong>{r.router ? "信令转接" : "MC 信令"}</strong>
                          <small>{r.signalingTarget || "目标未配置"}</small>
                        </div>
                        <i />
                        <div>
                          <span>
                            <Box size={15} />
                          </span>
                          <strong>同一世界</strong>
                          <small>共享实例</small>
                        </div>
                      </div>
                      <div className="route-facts">
                        <div>
                          <span>信令隧道</span>
                          <strong>
                            #{r.signalId}
                            <span
                              className={`small-dot ${r.signalRunning ? "green" : ""}`}
                            />
                          </strong>
                        </div>
                        <div>
                          <span>UDP 隧道</span>
                          <strong>
                            #{r.udpId || "未关联"}
                            <span
                              className={`small-dot ${r.udpRunning ? "green" : ""}`}
                            />
                          </strong>
                        </div>
                        <div>
                          <span>公网 UDP</span>
                          <code>
                            {r.udpHost}:{r.udpPort}
                          </code>
                        </div>
                        <div>
                          <span>本机 UDP 目标</span>
                          <code
                            className={
                              !q.data?.interfaces.includes(r.targetIP || "")
                                ? "danger-text"
                                : ""
                            }
                          >
                            {r.targetIP}:{r.targetPort}
                          </code>
                        </div>
                      </div>
                    </Disclosure>
                    <div className="route-entry-state">
                      <span>
                        信令{" "}
                        <strong>{r.signalRunning ? "运行" : "停止"}</strong>
                      </span>
                      <span>
                        UDP <strong>{r.udpRunning ? "运行" : "停止"}</strong>
                      </span>
                      <span>
                        {r.udpId === r.signalId ? "共用客户端" : "独立 UDP"}
                      </span>
                    </div>
                    <div className="route-card-actions">
                      <Button onClick={() => editRouter(r)}>
                        <Settings2 size={14} />
                        转接配置
                      </Button>
                      <Button
                        onClick={() =>
                          useApp
                            .getState()
                            .navigate(
                              "network",
                              `route-diagnostics-${r.signalId}`,
                            )
                        }
                      >
                        <Activity size={14} />
                        检测结果
                      </Button>
                      <Button
                        variant="primary"
                        disabled={
                          tunnelBusy ||
                          (r.clientReady === false && !r.signalRunning)
                        }
                        onClick={() =>
                          void routeAction(
                            r.signalId,
                            r.signalRunning || router?.running
                              ? "stop"
                              : "start",
                          )
                        }
                      >
                        {r.signalRunning || router?.running ? (
                          <Square size={12} />
                        ) : (
                          <Play size={12} />
                        )}
                        {r.udpId === r.signalId
                          ? r.signalRunning
                            ? "停止客户端"
                            : "启动客户端"
                          : r.signalRunning || router?.running
                            ? "停止信令"
                            : "启动信令"}
                      </Button>
                    </div>
                  </Panel>
                );
              })}
            {!visibleRows.length && (
              <Empty
                title="没有匹配的玩家入口"
                description="调整关键词或筛选条件。"
                action={
                  <Button
                    onClick={() => {
                      setRouteSearch("");
                      setRouteFilter("all");
                    }}
                  >
                    重置筛选
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <Panel>
            <Empty
              icon={Network}
              title="接入现有内网穿透"
              description="导入隧道后由工具中心的客户端运行；已有配置可迁移到管理程序目录。"
              action={
                <Button variant="primary" onClick={() => void attach()}>
                  <FolderOpen size={15} />
                  选择客户端目录
                </Button>
              }
            />
          </Panel>
        )}
      </section>
      <section
        {...tabPanelProps("network", "diagnostics")}
        className="network-view"
        hidden={section !== "diagnostics"}
        aria-label="线路检测工作区"
      >
        <div id="network-diagnostics" className="section-heading">
          <div>
            <h2>线路检测</h2>
            <p>查看信令与传输结果；检测仅在点击后执行。</p>
          </div>
          <Button
            variant="primary"
            disabled={!routes.length || measuring || !!qualityJob}
            onClick={() => void measure()}
          >
            <RefreshCw size={14} className={qualityJob ? "spin" : ""} />
            检测隧道线路
          </Button>
        </div>
        {quality.error && (
          <QueryError error={quality.error} retry={quality.reload} />
        )}
        {qualityJob && (
          <div className="network-quality-progress" aria-live="polite">
            <Activity size={16} />
            <div>
              <strong>{qualityJob.detail}</strong>
              <div className="progress-track">
                <span style={{ width: `${qualityJob.progress}%` }} />
              </div>
            </div>
            <span>{Math.round(qualityJob.progress)}%</span>
            <Button
              onClick={() => void act("jobs.cancel", { id: qualityJob.id })}
            >
              <X size={13} />
              取消检测
            </Button>
          </div>
        )}

        <div className="diagnostics-grid">
          {routes.map((route) => (
            <Panel
              id={`route-diagnostics-${route.signalId}`}
              className="network-diagnostic-card"
              key={route.signalId}
            >
              <div className="panel-heading">
                <div>
                  <h3>{route.name}</h3>
                  <p>
                    {route.host}:{route.port}
                  </p>
                </div>
                <Badge
                  tone={
                    signalStatus(
                      route,
                      q.data?.routers?.find(
                        (router) => router.signalId === route.signalId,
                      ),
                    ).tone
                  }
                >
                  {
                    signalStatus(
                      route,
                      q.data?.routers?.find(
                        (router) => router.signalId === route.signalId,
                      ),
                    ).label
                  }
                </Badge>
              </div>
              <RouteQuality
                route={route}
                report={quality.data}
                busy={measuring || !!qualityJob}
                onMeasure={() => void measure(route.signalId)}
              />
              <div className="panel-footer">
                <Button onClick={() => void diagnose(route)}>
                  <Activity size={14} />
                  基础诊断
                </Button>
                <Button onClick={() => void diagnose(route, true)}>
                  <Zap size={14} />
                  握手与重连测试
                </Button>
              </div>
            </Panel>
          ))}
        </div>
        {!routes.length && (
          <Empty
            icon={Activity}
            title="还没有隧道检测结果"
            description="导入隧道后可执行基础诊断、信令测量和握手测试。IPv6 检测位于对应玩家入口中。"
          />
        )}
        <Notice>
          基础检测检查进程、网卡、DNS、证书与信令。握手测试建立 ICE / DTLS /
          SCTP 连接，不执行游戏登录；信令耗时不代表游戏内延迟。
        </Notice>
      </section>
      <section
        {...tabPanelProps("network", "clients")}
        className="network-view"
        hidden={section !== "clients"}
        aria-label="隧道客户端工作区"
      >
        <div className="section-heading">
          <div>
            <h2>隧道客户端</h2>
            <p>同一配置只显示一个进程，TCP / UDP 共用客户端时同时启停。</p>
          </div>
          <Button onClick={() => useApp.getState().navigate("tools")}>
            <Wrench size={14} />
            工具与环境
          </Button>
        </div>
        {udpOnlyTunnels.length > 0 && (
          <section
            className="standalone-tunnels"
            aria-labelledby="standalone-tunnels-title"
          >
            <div className="section-heading">
              <div>
                <h2 id="standalone-tunnels-title">独立 UDP 隧道</h2>
                <p>已连接到云端转发节点，但尚未关联信令线路。</p>
              </div>
              <Badge tone="amber">仅传输层</Badge>
            </div>
            <div className="routes-grid">
              {udpOnlyTunnels.map((t) => {
                const address =
                  t.serverAddr && t.remotePort
                    ? `${t.serverAddr}:${t.remotePort}`
                    : "公网地址未配置";
                return (
                  <Panel className="route-card route-purple" key={t.id}>
                    <div className="route-card-top">
                      <div className="route-icon purple">
                        <Globe2 size={19} />
                      </div>
                      <div>
                        <h3>{t.node}</h3>
                        <small>
                          {t.provider === "frp-panel" ? "frp-panel" : "UDP"} · #
                          {t.id}
                        </small>
                      </div>
                      <Badge tone={t.running ? "green" : "neutral"}>
                        <span className="status-dot" />
                        {t.running ? "隧道运行中" : "隧道已停止"}
                      </Badge>
                    </div>
                    <div className="public-address">
                      <span>UDP 转发地址 · 非完整玩家入口</span>
                      <div>
                        <strong>{t.serverAddr || "地址未知"}</strong>
                        {t.remotePort && <code>{t.remotePort}</code>}
                        <IconButton
                          label="复制 UDP 转发地址"
                          disabled={!t.serverAddr || !t.remotePort}
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(address)
                              .then(() =>
                                useApp.getState().toast("UDP 地址已复制"),
                              )
                          }
                        >
                          <Copy size={15} />
                        </IconButton>
                      </div>
                      <small>
                        本机目标 {t.localIP}:{t.localPort} ·
                        该隧道尚未与信令入口配对
                      </small>
                    </div>
                    <Notice>
                      NetherNet 玩家线路还需要一个信令入口，并将信令与此 UDP
                      隧道关联。当前卡片只表示 UDP
                      转发已配置，不代表玩家可以通过它完成登录。
                    </Notice>
                    <div className="route-card-actions">
                      <Button
                        onClick={() =>
                          void act(
                            "tunnels.action",
                            {
                              id,
                              tunnelId: t.id,
                              action: t.running ? "stop" : "start",
                            },
                            "隧道操作已排队",
                          )
                        }
                      >
                        {t.running ? <Square size={14} /> : <Play size={14} />}
                        {t.running ? "停止隧道" : "启动隧道"}
                      </Button>
                    </div>
                  </Panel>
                );
              })}
            </div>
          </section>
        )}
        <div id="network-clients" className="network-client-processes">
          <Panel
            title="隧道进程"
            subtitle="展示本机生效配置；停止隧道会影响正在连接的玩家。"
            aside={
              q.data?.tunnels.length ? (
                <div className="inline-actions">
                  <Button
                    onClick={() =>
                      void act(
                        "tunnels.action",
                        { id, action: "start" },
                        "隧道启动已排队",
                      )
                    }
                  >
                    <Play size={13} />
                    全部启动
                  </Button>
                  <Button
                    onClick={() =>
                      void act(
                        "tunnels.action",
                        { id, action: "reload" },
                        "配置重载已排队",
                      )
                    }
                  >
                    <RefreshCw size={13} />
                    重载配置
                  </Button>
                </div>
              ) : null
            }
          >
            {q.data?.tunnels.length ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>隧道 / 节点</th>
                    <th>类型</th>
                    <th>本机目标</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {uniqueTunnelClients(q.data.tunnels).map((t) => {
                    const proxies = q.data!.tunnels.filter(
                      (p) => p.id === t.id && p.provider === t.provider,
                    );
                    return (
                      <tr key={`${t.provider}-${t.id}`}>
                        <td>
                          <strong>#{t.id}</strong>
                          <small className="cell-sub">{t.node}</small>
                          {proxies.length > 1 && (
                            <small className="cell-sub">
                              {proxies
                                .map((p) => p.type.toUpperCase())
                                .join(" + ")}{" "}
                              共用一个进程
                            </small>
                          )}
                        </td>
                        <td>
                          {proxies.map((p, n) => (
                            <Badge
                              key={n}
                              tone={p.type === "udp" ? "purple" : "blue"}
                            >
                              {p.type.toUpperCase()}
                            </Badge>
                          ))}
                          {proxies.some((p) => p.autoTLS) && (
                            <small className="cell-sub">AutoTLS 已配置</small>
                          )}
                        </td>
                        <td className="mono">
                          {proxies.map((p, n) => (
                            <div key={n} className="cell-sub">
                              {proxies.length > 1
                                ? `${p.type.toUpperCase()} · `
                                : ""}
                              {p.pluginTarget || `${p.localIP}:${p.localPort}`}
                              {p.type === "udp" && (
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    setTarget(p);
                                    setIP(p.localIP);
                                  }}
                                >
                                  修改网卡目标
                                </button>
                              )}
                            </div>
                          ))}
                        </td>
                        <td>
                          <Badge tone={t.running ? "green" : "neutral"}>
                            <span className="status-dot" />
                            {t.running ? "运行中" : "已停止"}
                          </Badge>
                          {t.pid && (
                            <small className="cell-sub mono">PID {t.pid}</small>
                          )}
                        </td>
                        <td>
                          <div className="inline-actions">
                            <Button
                              onClick={() =>
                                void act(
                                  "tunnels.action",
                                  {
                                    id,
                                    tunnelId: t.id,
                                    action: t.running ? "stop" : "start",
                                  },
                                  "隧道操作已排队",
                                )
                              }
                            >
                              {t.running ? "停止" : "启动"}
                            </Button>
                            <IconButton
                              label="查看隧道日志"
                              onClick={async () => {
                                const text = await act<string>("tunnels.log", {
                                  id,
                                  tunnelId: t.id,
                                });
                                if (text !== undefined)
                                  setLog({ id: t.id, text });
                              }}
                            >
                              <FileText size={16} />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty title="暂无关联隧道" />
            )}
          </Panel>
        </div>
      </section>
      <SignalRouterDialog
        id={id}
        edit={routerEdit}
        setEdit={setRouterEdit}
        tunnels={q.data?.tunnels || []}
        routers={q.data?.routers || []}
        onClose={() => setRouterEdit(null)}
        onSaved={q.reload}
      />
      <Drawer
        open={importing}
        onClose={() => {
          setImporting(false);
          setToken("");
        }}
        title="导入内网穿透隧道"
        description="先在工具中心安装对应客户端，再填写服务商的隧道编号与访问密钥。导入后可与现有线路同时运行。"
      >
        <div className="form-stack">
          <Field label="内网穿透服务商">
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as "lolia" | "sakura");
                setToken("");
              }}
            >
              <option value="lolia">LoliaFRP · HTTPS / UDP</option>
              <option value="sakura">SakuraFrp · 自动 HTTPS TCP / UDP</option>
            </select>
          </Field>
          <Field label="隧道编号">
            <input
              type="number"
              value={tunnelId}
              onChange={(e) => setTunnelId(e.target.value)}
              placeholder="例如：34727"
            />
          </Field>
          <Field
            label="访问令牌"
            hint="使用 Windows 当前用户加密保存；不会写入诊断报告。"
          >
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                provider === "sakura"
                  ? "樱花控制台访问密钥"
                  : "快捷启动命令冒号后的令牌"
              }
            />
          </Field>
          <Notice>
            {provider === "sakura" &&
              "樱花 TCP 请开启自动 HTTPS、选择反代至 HTTP，并绑定 nyat.app 域名；UDP 选择 MC 实际监听的网卡 IP。"}
            多入口需要分别配对 UDP 与信令隧道；各线路可在通用信令转接层中配置。
            导入后先检查线路和本机目标，再启动。
          </Notice>
          <div className="modal-actions">
            <Button
              onClick={() => {
                setImporting(false);
                setToken("");
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!tunnelId || !token}
              onClick={async () => {
                if (
                  await act(
                    "tunnels.import",
                    { id, provider, tunnelId: Number(tunnelId), token },
                    "导入任务已排队",
                  )
                ) {
                  setImporting(false);
                  setToken("");
                }
              }}
            >
              读取并导入
            </Button>
          </div>
        </div>
      </Drawer>
      <Drawer
        open={!!log}
        onClose={() => setLog(null)}
        title={`隧道 #${log?.id} 日志`}
        wide
      >
        <pre className="log-preview">{log?.text || "尚无日志输出"}</pre>
      </Drawer>
      <Drawer
        open={!!diagnostic}
        onClose={() => setDiagnostic(null)}
        title="线路诊断"
        description={diag?.title || "读取诊断任务"}
        wide
      >
        {diag ? (
          <>
            <JobProgress job={diag} />
            {Array.isArray(diag.result) && (
              <div className="diagnostic-results">
                {(diag.result as Diagnostic[]).map((r) => (
                  <div key={r.name} className={r.status}>
                    {r.status === "pass" ? (
                      <CheckCircle2 size={20} />
                    ) : r.status === "warn" ? (
                      <TriangleAlert size={20} />
                    ) : (
                      <XCircle size={20} />
                    )}
                    <div>
                      <strong>{r.name}</strong>
                      <p>{r.detail}</p>
                    </div>
                    {r.duration != null && <small>{r.duration} ms</small>}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <Loading />
        )}
      </Drawer>
      <Drawer
        open={!!target}
        onClose={() => setTarget(null)}
        title="修改 UDP 本机目标"
        description="选择实际监听 MC UDP 的网卡，保存后需要重新加载此隧道。"
      >
        <Field label="本机 IPv4 网卡">
          <select value={ip} onChange={(e) => setIP(e.target.value)}>
            {!q.data?.interfaces.includes(ip) && (
              <option value={ip}>{ip}（已失效或未识别）</option>
            )}
            {q.data?.interfaces.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </Field>
        <div className="modal-actions">
          <Button onClick={() => setTarget(null)}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              if (
                await act(
                  "tunnels.target",
                  { id, tunnelId: target?.id, ip },
                  "目标已保存",
                )
              ) {
                await act(
                  "tunnels.action",
                  { id, tunnelId: target?.id, action: "reload" },
                  "隧道重载已排队",
                );
                setTarget(null);
              }
            }}
          >
            保存并重载隧道
          </Button>
        </div>
      </Drawer>
    </div>
  );
}

export function SchedulesPage() {
  const data = useApp((s) => s.data)!;
  const id = useApp((s) => s.selected);
  const tasks = data.schedules.filter((s) => s.instanceId === id);
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  const [remove, setRemove] = useState<Schedule | null>(null);
  return (
    <div className="page">
      <Heading
        eyebrow="AUTOMATE THE ROUTINE"
        title="自动化计划"
        description="把例行维护交给后台，让注意力回到世界本身。"
        actions={
          <Button
            variant="primary"
            onClick={() =>
              setEditing({
                instanceId: id,
                name: "每日世界备份",
                cron: "0 4 * * *",
                action: "backup",
                enabled: false,
              })
            }
          >
            <Plus size={15} />
            创建计划任务
          </Button>
        }
      />
      <Notice>
        任务由独立后台执行。计划在电脑睡眠或关机期间错过时会跳过；同一实例维护忙碌时不会重复堆积任务。
      </Notice>
      <div className="schedule-grid">
        {tasks.map((s) => (
          <Panel key={s.id} className="schedule-card">
            <span className="table-icon">
              <CalendarClock size={21} />
            </span>
            <div className="schedule-summary">
              <div className="inline-actions">
                <h3>{s.name}</h3>
                <Badge tone={s.enabled ? "green" : "neutral"}>
                  {s.enabled ? "已启用" : "已暂停"}
                </Badge>
              </div>
              <p>
                {
                  {
                    backup: "世界备份",
                    restart: "倒计时重启",
                    start: "启动服务器",
                    stop: "正常保存关服",
                    command: "控制台命令",
                  }[s.action]
                }
              </p>
              <div className="schedule-cron">
                <Timer size={14} />
                <code>{s.cron}</code>
                <small>本机时区</small>
              </div>
            </div>
            <div>
              <div className="schedule-time">
                <span>下次执行</span>
                <strong>{s.enabled ? date(s.nextAt) : "未启用"}</strong>
              </div>
              <div className="schedule-time">
                <span>最近执行</span>
                <strong>{date(s.lastAt)}</strong>
              </div>
              {s.lastError && (
                <p className="danger-text" title={s.lastError}>
                  {s.lastError}
                </p>
              )}
            </div>
            <div className="schedule-actions">
              <Button onClick={() => setEditing(s)}>编辑</Button>
              <Button
                onClick={() =>
                  void act(
                    "schedules.save",
                    { ...s, enabled: !s.enabled },
                    s.enabled ? "任务已暂停" : "任务已启用",
                  )
                }
              >
                {s.enabled ? "暂停" : "启用"}
              </Button>
              <IconButton label="删除计划任务" onClick={() => setRemove(s)}>
                <Trash2 size={16} />
              </IconButton>
            </div>
          </Panel>
        ))}{" "}
        {!tasks.length && (
          <Panel className="span-all">
            <Empty
              icon={CalendarClock}
              title="让维护按时发生"
              description="安排每日备份、例行重启，或定时执行一条 MC 命令。"
              action={
                <Button
                  variant="primary"
                  onClick={() =>
                    setEditing({
                      instanceId: id,
                      name: "每日世界备份",
                      cron: "0 4 * * *",
                      action: "backup",
                      enabled: false,
                    })
                  }
                >
                  创建第一个任务
                </Button>
              }
            />
          </Panel>
        )}
      </div>
      <Drawer
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? "编辑计划任务" : "创建计划任务"}
        description="使用标准 Cron 表达式，时间按本机时区计算。"
      >
        <div className="form-stack">
          <Field label="任务名称">
            <input
              value={editing?.name || ""}
              onChange={(e) =>
                setEditing((s) => ({ ...s, name: e.target.value }))
              }
            />
          </Field>
          <Field label="执行动作">
            <select
              value={editing?.action || "backup"}
              onChange={(e) =>
                setEditing((s) => ({ ...s, action: e.target.value as any }))
              }
            >
              <option value="backup">世界备份</option>
              <option value="restart">提前 30 秒公告并重启</option>
              <option value="start">启动服务器</option>
              <option value="stop">正常保存关服</option>
              <option value="command">执行控制台命令</option>
            </select>
          </Field>
          <Field
            label="Cron 表达式"
            hint="分 时 日 月 星期；例如 0 4 * * * 表示每天 04:00。"
          >
            <input
              className="mono"
              value={editing?.cron || ""}
              onChange={(e) =>
                setEditing((s) => ({ ...s, cron: e.target.value }))
              }
            />
          </Field>
          <div className="preset-row">
            {[
              ["每天 04:00", "0 4 * * *"],
              ["每 6 小时", "0 */6 * * *"],
              ["每周日 04:00", "0 4 * * 0"],
            ].map(([label, cron]) => (
              <Button
                key={label}
                onClick={() => setEditing((s) => ({ ...s, cron }))}
              >
                {label}
              </Button>
            ))}
          </div>
          {editing?.action === "command" && (
            <Field label="MC 命令">
              <input
                value={editing.command || ""}
                onChange={(e) =>
                  setEditing((s) => ({ ...s, command: e.target.value }))
                }
                placeholder="say 欢迎来到方舟"
              />
            </Field>
          )}
          <Toggle
            checked={!!editing?.enabled}
            onChange={(enabled) => setEditing((s) => ({ ...s, enabled }))}
            label="启用任务"
            description="默认暂停，确认配置后再启用。"
          />
          <div className="modal-actions">
            <Button onClick={() => setEditing(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (
                  await act("schedules.save", editing as any, "计划任务已保存")
                )
                  setEditing(null);
              }}
            >
              保存任务
            </Button>
          </div>
        </div>
      </Drawer>
      <Confirm
        open={!!remove}
        onClose={() => setRemove(null)}
        title="删除计划任务"
        description={`删除「${remove?.name}」的定时安排，历史执行记录会保留。`}
        danger
        label="删除任务"
        onConfirm={async () => {
          await act("schedules.remove", { id: remove?.id }, "计划任务已删除");
        }}
      />
    </div>
  );
}

export function TasksPage() {
  const data = useApp((s) => s.data)!;
  const [tab, setTab] = useState("active");
  const [instance, setInstance] = useState("all");
  const [search, setSearch] = useState("");
  const [resultFilter, setResultFilter] = useState("all");
  const [detailId, setDetailId] = useState("");
  const detail = data.jobs.find((j) => j.id === detailId);
  const matches = (id: string | null) =>
    instance === "all" || (instance === "workspace" ? !id : id === instance);
  const jobs = data.jobs.filter(
    (j) =>
      matches(j.instanceId) &&
      (tab === "active"
        ? ["running", "queued"].includes(j.status)
        : !["running", "queued"].includes(j.status)) &&
      (tab !== "history" ||
        resultFilter === "all" ||
        (resultFilter === "issues"
          ? ["failed", "interrupted"].includes(j.status)
          : j.status === resultFilter)) &&
      `${j.title} ${j.detail}`.toLowerCase().includes(search.toLowerCase()),
  );
  const activities = data.activities.filter(
    (a) =>
      matches(a.instanceId) &&
      a.text.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="page">
      <Heading
        title="任务与记录"
        description="查看所有实例的后台执行进度、结果和操作记录。"
        actions={<Badge tone="green">独立后台持续执行</Badge>}
      />
      <div className="list-toolbar">
        <div className="segmented">
          {[
            ["active", "执行中"],
            ["history", "历史任务"],
            ["activity", "操作记录"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {label}
              {key === "active" && (
                <Badge>
                  {
                    data.jobs.filter((j) =>
                      ["running", "queued"].includes(j.status),
                    ).length
                  }
                </Badge>
              )}
            </button>
          ))}
        </div>
        <div className="inline-actions">
          {tab === "history" && (
            <select
              aria-label="筛选任务结果"
              className="compact-select"
              value={resultFilter}
              onChange={(e) => setResultFilter(e.target.value)}
            >
              <option value="all">全部结果</option>
              <option value="issues">失败 / 中断</option>
              <option value="success">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
          )}
          <select
            aria-label="筛选任务所属实例"
            className="compact-select"
            value={instance}
            onChange={(e) => setInstance(e.target.value)}
          >
            <option value="all">全部实例</option>
            <option value="workspace">工作空间</option>
            {data.instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="搜索任务或记录…"
          />
        </div>
      </div>
      <Panel>
        {tab === "activity" ? (
          activities.length ? (
            <div className="audit-list">
              {activities.map((a) => (
                <div key={a.id}>
                  <span className={`activity-dot ${a.level}`} />
                  <time>{date(a.at)}</time>
                  <div>
                    <Badge>
                      {data.instances.find((i) => i.id === a.instanceId)
                        ?.name || "工作空间"}
                    </Badge>
                    <p>{a.text}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={Activity} title="暂时没有匹配的操作记录" />
          )
        ) : jobs.length ? (
          <div className="task-list">
            {jobs.map((j) => (
              <div className="task-row" key={j.id}>
                <div className={`task-icon ${j.status}`}>
                  {j.status === "running" ? (
                    <LoaderCircle className="spin" size={20} />
                  ) : j.status === "success" ? (
                    <CheckCircle2 size={20} />
                  ) : ["failed", "interrupted"].includes(j.status) ? (
                    <TriangleAlert size={20} />
                  ) : (
                    <Clock3 size={20} />
                  )}
                </div>
                <div className="task-main">
                  <div>
                    <strong>{j.title}</strong>
                    <Status status={j.status} />
                  </div>
                  <p>{j.detail}</p>
                  <small>
                    {data.instances.find((i) => i.id === j.instanceId)?.name ||
                      "工作空间"}{" "}
                    · {date(j.createdAt)}
                    {j.finishedAt
                      ? ` · 耗时 ${duration((j.finishedAt - j.createdAt) / 1000)}`
                      : ""}
                  </small>
                  {["running", "queued"].includes(j.status) && (
                    <div className="progress-track">
                      <span style={{ width: `${j.progress}%` }} />
                    </div>
                  )}
                </div>
                <div className="task-actions">
                  <Button onClick={() => setDetailId(j.id)}>
                    {["running", "queued"].includes(j.status)
                      ? "查看进度"
                      : "查看结果"}
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={Activity}
            title={
              tab === "active"
                ? "当前没有执行中的任务"
                : "暂时没有匹配的历史任务"
            }
            description="备份、更新、检测与维护结果会记录在这里。"
          />
        )}
      </Panel>
      <Drawer
        open={!!detailId}
        onClose={() => setDetailId("")}
        title={detail?.title || "任务详情"}
        description={
          detail
            ? `${date(detail.createdAt)} · ${data.instances.find((i) => i.id === detail.instanceId)?.name || "工作空间"}`
            : ""
        }
        wide
      >
        {detail && (
          <>
            <JobProgress job={detail} />
            {detail.status === "failed" || detail.status === "interrupted" ? (
              <Notice tone="warn">{detail.detail}</Notice>
            ) : detail.status === "success" ? (
              <Notice tone="success">
                后台执行完成。详细结果与验证范围如下。
              </Notice>
            ) : (
              <Notice>
                进度来自后台实时事件。取消时会先完成必要的保存与恢复步骤。
              </Notice>
            )}
            {detail.result !== undefined && (
              <ResultSummary result={detail.result} />
            )}
            {["running", "queued"].includes(detail.status) && (
              <div className="modal-actions">
                <Button
                  variant="danger"
                  onClick={() =>
                    void act(
                      "jobs.cancel",
                      { id: detail.id },
                      "已请求取消；必要的保存与恢复步骤会先完成",
                    )
                  }
                >
                  请求取消任务
                </Button>
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}
const resultNames: Record<string, string> = {
  id: "记录标识",
  instanceId: "所属实例",
  kind: "类型",
  world: "世界",
  version: "版本",
  size: "文件大小",
  files: "文件",
  sha256: "SHA-256",
  verified: "校验通过",
  path: "路径",
  name: "名称",
  at: "记录时间",
  ok: "检查通过",
  error: "错误原因",
  detail: "执行说明",
  status: "状态",
  checks: "检查结果",
  routes: "线路结果",
  summary: "结果摘要",
  warning: "提示",
  warnings: "提示",
  source: "来源",
  installedVersion: "安装版本",
  latestVersion: "最新版本",
  compatible: "兼容",
  updated: "已更新",
  signal: "信令",
  udp: "UDP",
  playerLogin: "玩家登录",
  rttMs: "往返延迟（毫秒）",
  tool: "工具",
};
function ResultSummary({ result }: { result: unknown }) {
  const value = safeResult(result);
  const render = (v: unknown, depth = 0): React.ReactNode => {
    if (v == null) return "未提供";
    if (typeof v === "boolean") return v ? "是" : "否";
    if (typeof v !== "object") return String(v);
    if (depth > 3)
      return Array.isArray(v) ? `${v.length} 项记录` : "详细对象见技术数据";
    const entries = Array.isArray(v)
      ? v.slice(0, 30).map((item, i) => [String(i + 1), item] as const)
      : Object.entries(v);
    if (!entries.length) return "无";
    return (
      <dl className="task-results">
        {entries.map(([key, item]) => (
          <div className="result-field" key={key}>
            <dt>{resultNames[key] || key}</dt>
            <dd>{render(item, depth + 1)}</dd>
          </div>
        ))}
        {Array.isArray(v) && v.length > 30 && (
          <small>显示前 30 项，完整记录见技术数据。</small>
        )}
      </dl>
    );
  };
  return (
    <>
      {render(value)}
      <Disclosure title="技术数据（已脱敏）">
        <pre className="log-preview">{JSON.stringify(value, null, 2)}</pre>
      </Disclosure>
    </>
  );
}
function JobProgress({ job }: { job: Job }) {
  return (
    <div className="job-progress">
      <div>
        <Status status={job.status} />
        <strong>{Math.round(job.progress)}%</strong>
      </div>
      <div className="progress-track">
        <span style={{ width: `${job.progress}%` }} />
      </div>
      <p>{job.detail}</p>
    </div>
  );
}

export function SettingsPage() {
  const data = useApp((s) => s.data)!;
  const settings = data.settings;
  const id = useApp((s) => s.selected);
  const density = useApp((s) => s.density);
  const setDensity = useApp((s) => s.setDensity);
  const [tab, setTab] = useState("appearance");
  const [reloadingBackend, setReloadingBackend] = useState(false);
  const [retention, setRetention] = useState(settings.backupRetention);
  const [history, setHistory] = useState(settings.historyDays);
  async function exportReport() {
    const result = await act("diagnostics.export", id ? { id } : {});
    if (result)
      await window.ark.saveFile(
        `ArkMC-诊断-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(result, null, 2),
      );
  }
  return (
    <div className="page settings-page">
      <Heading
        eyebrow="MAKE IT YOURS"
        title="应用设置"
        description="设置界面偏好、托盘行为与数据保留策略。"
        actions={
          <Button onClick={() => void exportReport()}>
            <ArrowDownToLine size={15} />
            导出诊断报告
          </Button>
        }
      />
      <div className="settings-layout">
        <div className="settings-navigation">
          <PageTabs
            id="settings"
            label="应用设置分类"
            value={tab}
            onChange={setTab}
            items={[
              { value: "appearance", label: "外观与交互" },
              { value: "background", label: "后台与启动" },
              { value: "storage", label: "数据与存储" },
              { value: "notifications", label: "通知" },
              { value: "about", label: "关于方舟" },
            ]}
          />
        </div>
        <div className="settings-content" {...tabPanelProps("settings", tab)}>
          {tab === "appearance" && (
            <>
              <Panel title="外观主题" subtitle="为专注管理准备的两种配色">
                <div className="theme-picker">
                  {(["dark", "light"] as const).map((theme) => (
                    <button
                      key={theme}
                      className={`${theme} ${settings.theme === theme ? "selected" : ""}`}
                      onClick={() => void act("settings.save", { theme })}
                    >
                      <div className="theme-preview">
                        <span />
                        <div>
                          <i />
                          <i />
                          <i />
                        </div>
                      </div>
                      <span>
                        {theme === "dark" ? (
                          <Moon size={15} />
                        ) : (
                          <Sun size={15} />
                        )}{" "}
                        {theme === "dark" ? "黑曜石 · 深色" : "晨光 · 浅色"}
                        {settings.theme === theme && <CheckCircle2 size={16} />}
                      </span>
                    </button>
                  ))}
                </div>
              </Panel>
              <Panel title="界面行为">
                <div className="density-preference">
                  <div>
                    <strong>内容密度</strong>
                    <p>仅影响当前桌面布局；也可用标题栏按钮切换。</p>
                  </div>
                  <div className="segmented">
                    <button
                      className={density === "comfortable" ? "active" : ""}
                      aria-pressed={density === "comfortable"}
                      onClick={() => setDensity("comfortable")}
                    >
                      舒适
                    </button>
                    <button
                      className={density === "compact" ? "active" : ""}
                      aria-pressed={density === "compact"}
                      onClick={() => setDensity("compact")}
                    >
                      紧凑
                    </button>
                  </div>
                </div>
                <Toggle
                  checked={settings.reducedMotion}
                  onChange={(reducedMotion) =>
                    void act("settings.save", { reducedMotion })
                  }
                  label="减少动态效果"
                  description="停用浮动光效与非必要过渡，保留状态反馈。"
                />
              </Panel>
            </>
          )}
          {tab === "notifications" && (
            <Panel
              title="桌面通知"
              subtitle="任务完成与错误使用系统通知；全部操作记录仍可在任务页查看。"
            >
              {" "}
              <Toggle
                checked={settings.notifications}
                onChange={(notifications) =>
                  void act("settings.save", { notifications })
                }
                label="桌面通知"
                description="窗口不在前台时，通知任务完成和需要处理的错误。"
              />
            </Panel>
          )}
          {tab === "background" && (
            <Panel title="启动与后台">
              <Toggle
                checked={settings.closeToTray}
                onChange={(closeToTray) =>
                  void act("settings.save", { closeToTray })
                }
                label="关闭窗口时缩到系统托盘"
                description="默认开启，服务器、隧道和定时任务继续运行。"
              />
              <Toggle
                checked={settings.launchAtLogin}
                onChange={async (enabled) => {
                  try {
                    await window.ark.setLogin(enabled);
                    await act(
                      "settings.save",
                      { launchAtLogin: enabled },
                      enabled ? "已开启登录时启动" : "已关闭登录时启动",
                    );
                  } catch (error) {
                    useApp.getState().toast(message(error), "error");
                  }
                }}
                label="登录 Windows 时启动"
                description="默认关闭。便携程序应保存在固定位置后再启用。"
              />
              <Notice>
                关闭窗口默认缩到托盘。托盘“退出程序”会正常关服、停止托管线路，并同时关闭界面和后台。
              </Notice>
              <div className="inline-actions">
                <Badge>程序版本 {window.ark.versions.app}</Badge>
                <Button
                  disabled={
                    reloadingBackend || !!backendReloadBlock(data, true)
                  }
                  onClick={async () => {
                    setReloadingBackend(true);
                    try {
                      await window.ark.reloadBackend();
                      await useApp.getState().refresh();
                      useApp.getState().toast("管理后台已重载并重新连接");
                    } catch (error) {
                      useApp.getState().toast(message(error), "error");
                    } finally {
                      setReloadingBackend(false);
                    }
                  }}
                >
                  <RefreshCw size={14} />
                  {reloadingBackend ? "正在重载…" : "安全重载后台"}
                </Button>
              </div>
              <p className="core-update-help">
                {backendReloadBlock(data, true) ||
                  "仅重载管理服务；独立会话宿主与线路保持运行，重连后继续控制服务器。"}
              </p>
            </Panel>
          )}
          {tab === "storage" && (
            <>
              <Panel title="数据存储" subtitle="管理数据与服务器地图分别保存">
                <div className="storage-path">
                  <span>管理数据库、任务与历史</span>
                  <code>{data.dataRoot}</code>
                  <Button onClick={() => void window.ark.reveal(data.dataRoot)}>
                    <FolderOpen size={14} />
                    打开目录
                  </Button>
                </div>
                <div className="storage-path">
                  <span>备份目录</span>
                  <code>{settings.backupRoot}</code>
                  <Button
                    onClick={async () => {
                      const root = await window.ark.chooseDirectory();
                      if (root)
                        await act(
                          "settings.save",
                          { backupRoot: root },
                          "备份位置已更新",
                        );
                    }}
                  >
                    选择位置
                  </Button>
                </div>
              </Panel>
              <Panel title="保留策略">
                <div className="form-grid">
                  <Field label="自动备份保留份数" hint="手动备份不会自动删除。">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={retention}
                      onChange={(e) => setRetention(+e.target.value)}
                    />
                  </Field>
                  <Field
                    label="性能历史保留天数"
                    hint="操作记录默认保留 90 天。"
                  >
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={history}
                      onChange={(e) => setHistory(+e.target.value)}
                    />
                  </Field>
                </div>
                <div className="panel-footer">
                  <Button
                    variant="primary"
                    onClick={() =>
                      void act(
                        "settings.save",
                        { backupRetention: retention, historyDays: history },
                        "保留策略已保存",
                      )
                    }
                  >
                    保存策略
                  </Button>
                </div>
              </Panel>
            </>
          )}
          {tab === "about" && (
            <Panel className="about-panel">
              <div className="about-logo">
                <Box size={52} strokeWidth={1.4} />
              </div>
              <Badge tone="green">ARKMC STUDIO {window.ark.versions.app}</Badge>
              <h2>每一个世界，都值得用心管理。</h2>
              <p>
                面向 Windows 的基岩版服务器工作台。
                <br />
                官方 BDS · Endstone · 独立后台 · 多线路管理。
              </p>
              <div className="about-specs">
                <span>Electron {window.ark.versions.electron}</span>
                <span>React + TypeScript</span>
                <span>SQLite 本地存储</span>
                <span>Windows x64</span>
              </div>
              <Notice>
                自动检测结果会说明验证范围。完整游戏体验需要通过 Minecraft
                客户端验证。
              </Notice>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

export function InstanceDialog({
  open,
  onClose,
  updateId,
  suggestedVersion,
  suggestedCore,
}: {
  open: boolean;
  onClose: () => void;
  updateId?: string;
  suggestedVersion?: string;
  suggestedCore?: "bds" | "endstone";
}) {
  const ready = useApp((s) => !!s.data);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={updateId ? "更新服务器核心" : "添加你的服务器"}
      description={
        updateId
          ? "手动确认版本后，先准备兼容核心，再正常关服、备份和切换。"
          : "关联已有目录，或从官方来源创建新的独立实例。"
      }
      wide
    >
      {open && !ready && (
        <Notice tone="warn">
          连接后台后才能创建或关联实例。请关闭此窗口，重新连接工作空间。
        </Notice>
      )}
      {open && ready && (
        <InstanceForm
          onClose={onClose}
          updateId={updateId}
          suggestedVersion={suggestedVersion}
          suggestedCore={suggestedCore}
        />
      )}
    </Drawer>
  );
}
function InstanceForm({
  onClose,
  updateId,
  suggestedVersion,
  suggestedCore,
}: {
  onClose: () => void;
  updateId?: string;
  suggestedVersion?: string;
  suggestedCore?: "bds" | "endstone";
}) {
  const data = useApp((s) => s.data)!;
  const current = data.instances.find(
    (i) => i.id === (updateId || useApp.getState().selected),
  );
  const [mode, setMode] = useState(updateId ? "create" : "import");
  const [step, setStep] = useState(0);
  const [name, setName] = useState("新的方舟世界");
  const [root, setRoot] = useState(updateId ? current?.root || "" : "");
  const [tunnelRoot, setTunnelRoot] = useState("");
  const [core, setCore] = useState<"bds" | "endstone">(
    suggestedCore || current?.core || "endstone",
  );
  const [version, setVersion] = useState(suggestedVersion || "");
  const [zip, setZip] = useState("");
  const [port, setPort] = useState(19142);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const catalog = useQuery<{
    bds: { version: string; url: string } | null;
    endstone: { version: string; versions: string[] } | null;
    errors: string[];
  }>("install.catalog", {});
  async function submit() {
    setBusy(true);
    try {
      if (updateId) {
        const result = await act(
          "install.update",
          {
            id: updateId,
            version:
              version ||
              (core === "endstone"
                ? catalog.data?.endstone?.version
                : catalog.data?.bds?.version),
            zip: zip || undefined,
            targetCore: core,
          },
          "核心更新已排队",
        );
        if (result) onClose();
      } else if (mode === "import") {
        const result = await act<Instance>(
          "instances.import",
          { root, tunnelRoot: tunnelRoot || undefined },
          "服务器已关联",
        );
        if (result) {
          useApp.getState().select(result.id);
          onClose();
        }
      } else {
        const result = await act(
          "install.create",
          {
            name,
            root,
            core,
            version: version || catalog.data?.endstone?.version,
            zip: zip || undefined,
            port,
            accepted,
          },
          "服务器创建已排队，可在任务中心查看",
        );
        if (result) onClose();
      }
    } finally {
      setBusy(false);
    }
  }
  const finalStep = mode === "import" || !!updateId ? 1 : 2;
  const targetVersion =
    version ||
    (core === "endstone"
      ? catalog.data?.endstone?.version
      : catalog.data?.bds?.version);
  const canNext = updateId
    ? !!targetVersion || (core === "bds" && !!zip)
    : step === 0
      ? !!root.trim() &&
        (mode === "import" || (!!name.trim() && port >= 1 && port <= 65535))
      : !!targetVersion || (core === "bds" && !!zip);
  return (
    <div className="form-stack instance-wizard">
      <Steps
        items={
          updateId
            ? ["选择核心", "确认更新"]
            : mode === "import"
              ? ["选择目录", "确认接入"]
              : ["实例信息", "核心与版本", "确认创建"]
        }
        current={step}
      />
      {!updateId && step === 0 && (
        <div className="segmented instance-tabs">
          <button
            className={mode === "import" ? "active" : ""}
            onClick={() => {
              setMode("import");
              setAccepted(false);
            }}
          >
            接入已有服务器
          </button>
          <button
            className={mode === "create" ? "active" : ""}
            onClick={() => {
              setMode("create");
              setAccepted(false);
            }}
          >
            创建新服务器
          </button>
        </div>
      )}
      {!updateId && step === 0 && (
        <>
          {mode === "import" ? (
            <Notice>
              从原目录读取世界、模组与启动方式。接入不会复制或重启服务器。
            </Notice>
          ) : (
            <div className="form-grid">
              <Field label="服务器名称">
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="IPv4 端口" hint="创建时检查端口占用。">
                <input
                  type="number"
                  value={port}
                  min={1}
                  max={65535}
                  onChange={(e) => setPort(+e.target.value)}
                />
              </Field>
            </div>
          )}
          <Field label={mode === "import" ? "已有服务器目录" : "新的空目录"}>
            <PathInput
              value={root}
              onChange={setRoot}
              placeholder={
                mode === "import"
                  ? "选择包含 server.properties 的核心目录"
                  : "填写或选择独立空目录"
              }
            />
          </Field>
          {mode === "import" && (
            <Disclosure title="已有第三方客户端（可选）">
              <Field label="客户端配置目录">
                <PathInput
                  value={tunnelRoot}
                  onChange={setTunnelRoot}
                  placeholder="留空可在网络页导入"
                />
              </Field>
            </Disclosure>
          )}
        </>
      )}
      {(updateId ? step === 0 : mode === "create" && step === 1) && (
        <>
          <Field label="服务端核心">
            <div className="core-picker">
              {(["endstone", "bds"] as const).map((k) => (
                <button
                  key={k}
                  className={core === k ? "selected" : ""}
                  onClick={() => {
                    setCore(k);
                    setVersion("");
                    setZip("");
                  }}
                >
                  <Layers size={23} />
                  <div>
                    <strong>
                      {k === "endstone" ? "Endstone" : "官方 BDS"}
                    </strong>
                    <small>
                      {k === "endstone"
                        ? "官方核心扩展 · 支持插件"
                        : "原版服务端 · 官方发行"}
                    </small>
                  </div>
                  {core === k && <CheckCircle2 size={17} />}
                </button>
              ))}
            </div>
          </Field>
          {catalog.error && (
            <QueryError error={catalog.error} retry={catalog.reload} />
          )}
          {!!catalog.data?.errors.length && (
            <Notice tone="warn">{catalog.data.errors.join("；")}</Notice>
          )}
          {core === "endstone" ? (
            <Field
              label="Endstone 版本"
              hint="使用独立 Python 3.13；按官方元数据匹配 BDS。"
            >
              <select
                value={targetVersion || ""}
                onChange={(e) => setVersion(e.target.value)}
              >
                {!catalog.data?.endstone && (
                  <option value="">读取官方版本中…</option>
                )}
                {catalog.data?.endstone?.versions.map((v) => (
                  <option value={v} key={v}>
                    {v}
                    {v === catalog.data?.endstone?.version
                      ? " · 当前稳定版"
                      : ""}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <>
              <Notice>
                官方当前版本：{catalog.data?.bds?.version || "尚未读取"}
                。留空安装包将从官方渠道下载。
              </Notice>
              <Field label="官方 ZIP（可选）">
                <PathInput
                  value={zip}
                  onChange={setZip}
                  file
                  extensions={["zip"]}
                  placeholder="选择已有官方安装包"
                />
              </Field>
            </>
          )}
          {updateId && current && core !== current.core && (
            <Notice tone="warn">
              {core === "bds"
                ? "切换到官方 BDS 后，世界与行为包保留，Endstone 插件暂停加载。独立环境保留，适配后可切回。"
                : "切换到 Endstone 官方兼容组合；配套 BDS 低于当前版本时会拒绝降级以保护世界。"}
            </Notice>
          )}
        </>
      )}
      {step === finalStep && (
        <>
          <dl className="detail-grid vertical">
            <div>
              <dt>{updateId ? "更新实例" : "实例目录"}</dt>
              <dd>{updateId ? current?.name : root}</dd>
            </div>
            {mode === "create" && (
              <>
                <div>
                  <dt>核心与版本</dt>
                  <dd>
                    {core === "endstone" ? "Endstone" : "官方 BDS"} ·{" "}
                    {zip ? "从官方安装包导入" : targetVersion || "尚未选择"}
                  </dd>
                </div>
                {!updateId && (
                  <div>
                    <dt>名称与端口</dt>
                    <dd>
                      {name} · {port}
                    </dd>
                  </div>
                )}
              </>
            )}
          </dl>
          {mode === "import" ? (
            <Notice>
              关联后先展示真实状态。配置写入、启停和维护由页面中的操作提交。
            </Notice>
          ) : updateId ? (
            <>
              <Notice tone="warn">
                准备兼容核心后，正常关服并创建完整保护快照，再切换版本。原本运行的实例会重新启动；失败时尝试回退。
              </Notice>
              <label className="checkbox-label eula">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>
                  我确认手动更新该实例，并允许正常关服与创建完整恢复点。
                </span>
              </label>
            </>
          ) : (
            <label className="checkbox-label eula">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                我已阅读并同意{" "}
                <a
                  href="https://www.minecraft.net/eula"
                  target="_blank"
                  rel="noreferrer"
                >
                  Minecraft EULA
                </a>
                ，确认创建服务器。
              </span>
            </label>
          )}
        </>
      )}
      <div className="modal-actions">
        <Button
          disabled={busy}
          onClick={() => (step ? setStep((s) => s - 1) : onClose())}
        >
          {step ? "上一步" : "取消"}
        </Button>
        {step < finalStep ? (
          <Button
            variant="primary"
            disabled={!canNext}
            onClick={() => setStep((s) => s + 1)}
          >
            下一步
            <ArrowRight size={14} />
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || (mode === "create" && !accepted)}
            onClick={() => void submit()}
          >
            {busy && <LoaderCircle className="spin" size={15} />}{" "}
            {updateId
              ? "准备更新并创建恢复点"
              : mode === "import"
                ? "接入并识别"
                : "从官方来源创建"}
          </Button>
        )}
      </div>
    </div>
  );
}
