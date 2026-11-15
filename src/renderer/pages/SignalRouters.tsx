import { useState } from "react";
import { Link2, Play, RefreshCw, Save, Settings2, Square } from "lucide-react";
import type { Route, SignalRouterConfig, Tunnel } from "../../shared/types";
import { routerConfigError } from "../../shared/network";
import { act } from "../store";
import { Badge, Button, Field, Drawer, Notice } from "../components";

export type Router = SignalRouterConfig & {
  running: boolean;
  healthy: boolean;
};
export function createRouter(
  route: Route,
  routers: Router[],
  endpoint: { publicUdpIP?: string; publicUdpPort?: number } | undefined,
  mcPort: number,
): SignalRouterConfig {
  const occupied = new Set([...routers.map((r) => r.listenPort), mcPort]);
  let port = 19232;
  while (occupied.has(port)) port += 100;
  return {
    key: `route-${route.signalId}`,
    name: route.name,
    signalId: route.signalId,
    udpId: route.udpId || 0,
    enabled: true,
    listenIP: "127.0.0.1",
    listenPort: port,
    upstream: `http://127.0.0.1:${mcPort}`,
    sourceUdpIP: endpoint?.publicUdpIP || "",
    sourceUdpPort: Number(endpoint?.publicUdpPort) || mcPort,
    publicUdpIP: route.udpHost || "",
    publicUdpPort: route.udpPort || mcPort,
    relayOnly: true,
  };
}
export function SignalRouterSection({
  route,
  router,
  busy,
  onEdit,
  onAction,
}: {
  route: Route;
  router?: Router;
  busy: boolean;
  onEdit: () => void;
  onAction: (action: "start" | "stop" | "reload") => void;
}) {
  const running = route.signalRunning || !!router?.running;
  const sharedClient = route.udpId === route.signalId;
  return (
    <div className="route-section route-router-section">
      <div className="route-section-heading">
        <h4>
          <Link2 size={14} />
          信令转接
        </h4>
        <Badge
          tone={
            router?.healthy ? "green" : router?.enabled ? "amber" : "neutral"
          }
        >
          {router?.healthy
            ? "转接健康"
            : router?.enabled
              ? router.running
                ? "健康检查未通过"
                : "已配置 / 未运行"
              : router
                ? "已禁用"
                : "直连 MC"}
        </Badge>
        <Button onClick={onEdit}>
          <Settings2 size={13} />
          转接配置
        </Button>
      </div>
      {router ? (
        <>
          <div className="route-router-endpoint">
            <span>协商下发 UDP</span>
            <code>
              {router.enabled
                ? `${router.publicUdpIP}:${router.publicUdpPort}`
                : "使用 MC 原始下发地址"}
            </code>
          </div>
        </>
      ) : (
        <p className="route-inline-help">
          当前信令直接转发到 MC。多入口需下发各自 UDP
          地址时，可在本线路配置通用转接。
        </p>
      )}
      <div className="route-section-footer">
        <small>
          {sharedClient
            ? "TCP / UDP 共用客户端，启停会同时影响本线路"
            : router?.enabled
              ? router.relayOnly
                ? "限定本线路候选 · 随信令一起启停"
                : "保留原始候选 · 随信令一起启停"
              : "信令隧道独立管理"}
        </small>
        <div className="inline-actions">
          <Button
            disabled={busy}
            onClick={() => onAction(running ? "stop" : "start")}
          >
            {running ? <Square size={12} /> : <Play size={12} />}
            {sharedClient
              ? running
                ? "停止客户端"
                : "启动客户端"
              : running
                ? "停止信令"
                : "启动信令"}
          </Button>
          <Button
            disabled={busy || !running}
            onClick={() => onAction("reload")}
          >
            <RefreshCw size={12} />
            重载信令
          </Button>
        </div>
      </div>
    </div>
  );
}
export default function SignalRouterDialog({
  id,
  edit,
  setEdit,
  tunnels,
  routers,
  onClose,
  onSaved,
}: {
  id: string;
  edit: SignalRouterConfig | null;
  setEdit: React.Dispatch<React.SetStateAction<SignalRouterConfig | null>>;
  tunnels: Tunnel[];
  routers: Router[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const signal = tunnels.filter(
    (t) =>
      ["https", "http"].includes(t.type) || (t.type === "tcp" && t.autoTLS),
  );
  const udp = tunnels.filter((t) => t.type === "udp");
  const blocked =
    tunnels.some((t) => t.id === edit?.signalId && t.running) ||
    routers.some((r) => r.key === edit?.key && r.running);
  const invalid = edit ? routerConfigError(edit) : "";
  const change = <K extends keyof SignalRouterConfig>(
    key: K,
    value: SignalRouterConfig[K],
  ) => setEdit((item) => (item ? { ...item, [key]: value } : item));
  return (
    <>
      <Drawer
        open={!!edit}
        onClose={onClose}
        title="信令转接配置"
        description="适用于任意线路。停止该信令隧道及转接层后保存，再重新加载线路生效。"
      >
        {blocked && (
          <Notice tone="warn">
            该信令隧道或转接层正在运行。请先在所属线路卡片停止信令，再保存配置。
          </Notice>
        )}
        {edit && (
          <div className="config-fields">
            <Field label="线路名称">
              <input
                value={edit.name}
                onChange={(e) => change("name", e.target.value)}
              />
            </Field>
            <Field label="信令隧道">
              <select
                aria-label="信令隧道"
                value={edit.signalId}
                onChange={(e) => change("signalId", Number(e.target.value))}
              >
                {signal.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} · {t.host || t.node}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="UDP 隧道">
              <select
                aria-label="UDP 隧道"
                value={edit.udpId}
                onChange={(e) => {
                  change("udpId", Number(e.target.value));
                  const t = udp.find((v) => v.id === Number(e.target.value));
                  if (t?.remotePort) change("publicUdpPort", t.remotePort);
                }}
              >
                {udp.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} · {t.node}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="本机监听端口">
              <input
                type="number"
                min={1024}
                max={65535}
                value={edit.listenPort}
                onChange={(e) => change("listenPort", Number(e.target.value))}
              />
            </Field>
            <Field label="上游 MC 信令">
              <input
                value={edit.upstream}
                onChange={(e) => change("upstream", e.target.value)}
                placeholder="http://127.0.0.1:19132"
              />
            </Field>
            <Field label="原始 UDP 地址">
              <input
                value={edit.sourceUdpIP}
                onChange={(e) => change("sourceUdpIP", e.target.value)}
                placeholder="MC 当前下发的公网 IPv4"
              />
            </Field>
            <Field label="原始 UDP 端口">
              <input
                type="number"
                value={edit.sourceUdpPort}
                onChange={(e) =>
                  change("sourceUdpPort", Number(e.target.value))
                }
              />
            </Field>
            <Field label="本线路公网 UDP 地址">
              <input
                value={edit.publicUdpIP}
                onChange={(e) => change("publicUdpIP", e.target.value)}
                placeholder="该 UDP 隧道节点的公网 IPv4"
              />
            </Field>
            <Field label="本线路公网 UDP 端口">
              <input
                type="number"
                value={edit.publicUdpPort}
                onChange={(e) =>
                  change("publicUdpPort", Number(e.target.value))
                }
              />
            </Field>
            <Field label="转接状态">
              <select
                value={String(edit.enabled)}
                onChange={(e) => change("enabled", e.target.value === "true")}
              >
                <option value="true">启用转接</option>
                <option value="false">禁用，直接转发至 MC</option>
              </select>
            </Field>
            <Field label="连接候选策略">
              <select
                value={String(edit.relayOnly)}
                onChange={(e) => change("relayOnly", e.target.value === "true")}
              >
                <option value="true">限制为所选线路</option>
                <option value="false">保留玩家原始连接候选</option>
              </select>
            </Field>
          </div>
        )}
        <Notice>
          只调整协商时使用的 UDP 地址；服务端签名、DTLS 指纹与 ICE
          凭据保持原样。请使用该 UDP 隧道的实际公网地址。
        </Notice>
        {invalid && <Notice tone="warn">{invalid}</Notice>}
        <div className="modal-actions">
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={blocked || saving || !!invalid}
            onClick={async () => {
              setSaving(true);
              try {
                if (
                  edit &&
                  (await act(
                    "routers.save",
                    { id, config: edit },
                    "转接层已保存，请启动或重新加载信令隧道",
                  ))
                ) {
                  onClose();
                  onSaved();
                }
              } finally {
                setSaving(false);
              }
            }}
          >
            <Save size={14} />
            保存转接配置
          </Button>
        </div>
      </Drawer>
    </>
  );
}
