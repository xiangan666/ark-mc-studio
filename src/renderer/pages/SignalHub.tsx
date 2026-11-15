import { useState } from "react";
import {
  ArrowRight,
  Check,
  Link2,
  Play,
  RefreshCw,
  Settings2,
  Square,
  Workflow,
  Wrench,
} from "lucide-react";
import type { Route, Tunnel } from "../../shared/types";
import type { TunnelClientStatus } from "../../agent/tunnel-clients";
import { routerConfigError, tunnelClients } from "../../shared/network";
import { message, useApp } from "../store";
import {
  Badge,
  Button,
  Drawer,
  Field,
  Notice,
  Panel,
  useUnsavedChanges,
} from "../components";
import type { Router } from "./SignalRouters";

export function signalStatus(route: Route, router?: Router) {
  if (route.clientReady === false)
    return { label: "缺少客户端", tone: "red" as const };
  if (!route.udpId)
    return {
      label: route.pairingAmbiguous ? "UDP 配对不唯一" : "待配对 UDP",
      tone: "amber" as const,
    };
  if (router?.enabled && !router.healthy)
    return {
      label: router.running ? "转接异常" : "转接未运行",
      tone: "amber" as const,
    };
  if (!route.signalRunning || !route.udpRunning)
    return { label: "线路未启动", tone: "neutral" as const };
  return {
    label: router?.enabled ? "转接就绪" : "直达 MC",
    tone: "green" as const,
  };
}

export default function SignalHub({
  id,
  routes,
  tunnels,
  routers,
  clients,
  busy,
  onEdit,
  onAction,
  onSaved,
}: {
  id: string;
  routes: Route[];
  tunnels: Tunnel[];
  routers: Router[];
  clients: TunnelClientStatus[];
  busy: boolean;
  onEdit: (route: Route) => void;
  onAction: (signalId: number, action: "start" | "stop" | "reload") => void;
  onSaved: () => void;
}) {
  const [unifying, setUnifying] = useState(false);
  const enabled = routers.filter((r) => r.enabled);
  const healthy = enabled.filter((r) => r.healthy).length;
  const upstreams = [
    ...new Set(enabled.map((r) => r.upstream.replace(/\/$/, ""))),
  ];
  const incomplete = routes.filter(
    (r) => !routers.some((v) => v.signalId === r.signalId && v.enabled),
  ).length;
  return (
    <Panel className="signal-hub" id="network-signaling">
      <div className="signal-hub-heading">
        <span className="signal-hub-icon">
          <Workflow size={20} />
        </span>
        <div>
          <h2>统一信令转接</h2>
          <p>同一 MC 上游，独立 UDP 映射。所有隧道线路在这里管理。</p>
        </div>
        <Badge
          tone={
            enabled.length && healthy === enabled.length
              ? "green"
              : enabled.length
                ? "amber"
                : "neutral"
          }
        >
          {enabled.length
            ? `${healthy} / ${enabled.length} 转接健康`
            : "尚未配置转接"}
        </Badge>
        <Button
          disabled={!routers.length || busy}
          onClick={() => setUnifying(true)}
        >
          <Settings2 size={14} />
          统一上游配置
        </Button>
      </div>
      <div className="signal-hub-topology">
        <div>
          <small>01 · 玩家信令</small>
          <strong>{routes.length} 条隧道入口</strong>
          <span>HTTPS / HTTP / TCP</span>
        </div>
        <ArrowRight size={18} />
        <div>
          <small>02 · 按线路转接</small>
          <strong>{enabled.length} 组 UDP 映射</strong>
          <span>
            {incomplete
              ? `${incomplete} 条仍使用 MC 原始候选`
              : "候选地址与所选线路对应"}
          </span>
        </div>
        <ArrowRight size={18} />
        <div>
          <small>03 · 同一个世界</small>
          <strong>
            {upstreams.length > 1
              ? "MC 上游不一致"
              : upstreams[0] || "等待转接配置"}
          </strong>
          <span>
            {upstreams.length > 1
              ? "可统一上游，保留独立映射"
              : "保留身份、指纹与 ICE 凭据"}
          </span>
        </div>
      </div>
      {!!clients.length && (
        <div className="signal-client-strip" aria-label="穿透工具识别结果">
          <span>
            <Wrench size={13} />
            客户端识别
          </span>
          {clients.map((c) => (
            <button
              key={c.provider}
              className={`signal-client ${c.ready ? "ready" : "missing"}`}
              title={c.detail}
              onClick={() => useApp.getState().navigate("tools")}
            >
              <span className="status-dot" />
              {c.name}
              <small>{c.ready ? c.version || c.format : "待安装 / 修复"}</small>
            </button>
          ))}
        </div>
      )}
      <div className="table-scroll">
        <table className="data-table signal-route-table">
          <thead>
            <tr>
              <th>玩家信令入口</th>
              <th>转接 → 公网 UDP</th>
              <th>分层状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => {
              const router = routers.find((r) => r.signalId === route.signalId);
              const status = signalStatus(route, router);
              const tunnel = tunnels.find((t) => t.id === route.signalId);
              return (
                <tr key={route.signalId}>
                  <td>
                    <strong>{route.name}</strong>
                    <code className="cell-sub">
                      {route.host}:{route.port}
                    </code>
                    <small className="muted">
                      {tunnelClients[tunnel?.provider || "lolia"].name} · #
                      {route.signalId}
                    </small>
                  </td>
                  <td>
                    <code>
                      {router?.enabled
                        ? `${router.listenIP}:${router.listenPort}`
                        : "MC 原始信令"}
                    </code>
                    <span className="signal-mapping-arrow">→</span>
                    <code>
                      {router?.enabled
                        ? `${router.publicUdpIP}:${router.publicUdpPort}`
                        : route.udpHost && route.udpPort
                          ? `${route.udpHost}:${route.udpPort}`
                          : "尚未配对"}
                    </code>
                    <small className="cell-sub">
                      {router?.enabled ? router.upstream : "未启用转接"}
                    </small>
                  </td>
                  <td>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <small className="cell-sub">
                      信令 {route.signalRunning ? "运行" : "停止"} · UDP{" "}
                      {route.udpRunning ? "运行" : "停止"}
                    </small>
                  </td>
                  <td>
                    <div className="inline-actions">
                      <Button
                        disabled={
                          busy ||
                          (route.clientReady === false &&
                            !route.signalRunning &&
                            !router?.running)
                        }
                        onClick={() =>
                          onAction(
                            route.signalId,
                            route.signalRunning || router?.running
                              ? "stop"
                              : "start",
                          )
                        }
                      >
                        {route.signalRunning || router?.running ? (
                          <Square size={12} />
                        ) : (
                          <Play size={12} />
                        )}
                        {route.udpId === route.signalId
                          ? route.signalRunning || router?.running
                            ? "停止客户端"
                            : "启动客户端"
                          : route.signalRunning || router?.running
                            ? "停止信令"
                            : "启动信令"}
                      </Button>
                      <Button
                        disabled={
                          busy || !(route.signalRunning || router?.running)
                        }
                        onClick={() => onAction(route.signalId, "reload")}
                      >
                        <RefreshCw size={12} />
                        重载信令
                      </Button>
                      <Button disabled={busy} onClick={() => onEdit(route)}>
                        <Settings2 size={12} />
                        配置
                      </Button>
                    </div>
                    {route.udpId === route.signalId && (
                      <small className="cell-sub">TCP / UDP 同时启停</small>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="signal-hub-footer">
        <Link2 size={13} />
        <span>
          线路控制不停止游戏核心。独立 UDP 分别管理；共用客户端的 TCP / UDP
          会同时启停。IPv6 使用独立服务。
        </span>
      </div>
      {unifying && (
        <UnifiedUpstream
          key={id}
          id={id}
          routers={routers}
          tunnels={tunnels}
          onClose={() => setUnifying(false)}
          onSaved={onSaved}
        />
      )}
    </Panel>
  );
}

function UnifiedUpstream({
  id,
  routers,
  tunnels,
  onClose,
  onSaved,
}: {
  id: string;
  routers: Router[];
  tunnels: Tunnel[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = routers.find((r) => r.enabled) || routers[0];
  const [upstream, setUpstream] = useState(initial.upstream);
  const [sourceIP, setSourceIP] = useState(initial.sourceUdpIP);
  const [sourcePort, setSourcePort] = useState(initial.sourceUdpPort);
  const blocked = (r: Router) =>
    r.running || tunnels.some((t) => t.id === r.signalId && t.running);
  const [selected, setSelected] = useState(() =>
    routers.filter((r) => !blocked(r)).map((r) => r.key),
  );
  const [saved, setSaved] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const configs = routers
    .filter((r) => selected.includes(r.key) && !saved.includes(r.key))
    .map((r) => ({
      ...r,
      upstream,
      sourceUdpIP: sourceIP.trim(),
      sourceUdpPort: sourcePort,
    }));
  const invalid = configs.map(routerConfigError).find(Boolean);
  useUnsavedChanges(
    upstream !== initial.upstream ||
      sourceIP !== initial.sourceUdpIP ||
      sourcePort !== initial.sourceUdpPort,
    "统一信令上游配置",
  );
  async function save() {
    setSaving(true);
    setError("");
    try {
      for (const config of configs) {
        const current = await window.ark.call<{
          tunnels: Tunnel[];
          routers?: Router[];
        }>("tunnels.get", { id });
        const previous = current.routers?.find((r) => r.key === config.key);
        if (
          !previous ||
          previous.running ||
          current.tunnels.some((t) => t.id === previous.signalId && t.running)
        )
          throw new Error(
            `${config.name} 状态已变化，请停止信令后重新打开配置`,
          );
        const original = routers.find((r) => r.key === config.key)!;
        if (
          Object.keys(original).some(
            (k) =>
              !["running", "healthy"].includes(k) &&
              previous[k as keyof Router] !== original[k as keyof Router],
          )
        )
          throw new Error(`${config.name} 配置已被修改，请刷新后重新设置`);
        await window.ark.call("routers.save", {
          id,
          config: {
            ...previous,
            upstream,
            sourceUdpIP: sourceIP.trim(),
            sourceUdpPort: sourcePort,
          },
        });
        setSaved((items) => [...items, config.key]);
      }
      useApp.getState().toast("所选线路的上游已统一，独立 UDP 映射保持原样");
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
      onSaved();
    } finally {
      setSaving(false);
    }
  }
  return (
    <Drawer
      open
      onClose={() => !saving && onClose()}
      title="统一上游配置"
      description="统一 MC 上游与原始 UDP 候选来源，保留每条线路的独立映射。"
    >
      <Notice>
        运行中的信令已锁定。请先停止需要调整的信令，再选择对应线路；保存后手动启动生效。
      </Notice>
      <div className="config-fields">
        <Field label="统一 MC 上游">
          <input
            value={upstream}
            disabled={saving}
            onChange={(e) => setUpstream(e.target.value)}
          />
        </Field>
        <Field label="统一原始 UDP 地址">
          <input
            value={sourceIP}
            disabled={saving}
            onChange={(e) => setSourceIP(e.target.value)}
          />
        </Field>
        <Field label="统一原始 UDP 端口">
          <input
            type="number"
            min={1}
            max={65535}
            value={sourcePort}
            disabled={saving}
            onChange={(e) => setSourcePort(+e.target.value)}
          />
        </Field>
      </div>
      <div className="signal-unify-list">
        {routers.map((r) => (
          <label key={r.key}>
            <input
              type="checkbox"
              aria-label={`统一 ${r.name}`}
              disabled={saving || blocked(r) || saved.includes(r.key)}
              checked={selected.includes(r.key)}
              onChange={(e) =>
                setSelected((items) =>
                  e.target.checked
                    ? [...items, r.key]
                    : items.filter((k) => k !== r.key),
                )
              }
            />
            <span>
              <strong>{r.name}</strong>
              <code>
                {r.publicUdpIP}:{r.publicUdpPort}
              </code>
            </span>
            <Badge tone={saved.includes(r.key) ? "green" : "neutral"}>
              {saved.includes(r.key)
                ? "已保存"
                : blocked(r)
                  ? "运行中 · 已锁定"
                  : "可调整"}
            </Badge>
          </label>
        ))}
      </div>
      {(error || invalid) && <Notice tone="warn">{error || invalid}</Notice>}
      {!!saved.length && error && (
        <Notice>
          已保存 {saved.length}{" "}
          条线路。未完成的线路未自动重试；请核对最新配置后继续。
        </Notice>
      )}
      <div className="modal-actions">
        <Button disabled={saving} onClick={onClose}>
          关闭
        </Button>
        <Button
          variant="primary"
          disabled={saving || !configs.length || !!invalid}
          onClick={() => void save()}
        >
          {saving ? (
            <RefreshCw className="spin" size={14} />
          ) : (
            <Check size={14} />
          )}
          保存到 {configs.length} 条线路
        </Button>
      </div>
    </Drawer>
  );
}
