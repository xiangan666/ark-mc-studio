import { useState } from "react";
import { Copy, Globe2, Play, RefreshCw, Square } from "lucide-react";
import {
  Badge,
  Button,
  Disclosure,
  IconButton,
  Notice,
  Panel,
  QueryError,
} from "../components";
import { act, bytes, date, useApp } from "../store";
import type { DirectRouteReport, DirectRouteStatus } from "../../shared/direct";

export default function DirectRoute({
  id,
  query: q,
}: {
  id: string;
  query: { data: DirectRouteStatus | null; error: string; reload: () => void };
}) {
  const [pending, setPending] = useState(false);
  const [latestReport, setReport] = useState<DirectRouteReport | null>(null);
  const route = q.data;
  if (q.error) return <QueryError error={q.error} retry={q.reload} />;
  if (!route?.configured) return null;
  const report = latestReport || route.diagnostic;
  const transport = report?.checks.find(
    (check) => check.name === "IPv6 ICE / DTLS / SCTP",
  );
  const stale =
    !report || Date.now() - Date.parse(report.testedAt) > 10 * 60000;
  const certDays = route.certificateExpires
    ? Math.floor((Date.parse(route.certificateExpires) - Date.now()) / 86400000)
    : null;
  async function action(action: string) {
    setPending(true);
    try {
      await act("direct.action", { id, action }, "IPv6 直连操作完成");
      q.reload();
    } finally {
      setPending(false);
    }
  }
  async function diagnose() {
    setPending(true);
    try {
      const value = await act<DirectRouteReport>("direct.diagnose", {
        id,
        advanced: true,
      });
      if (value) setReport(value);
      q.reload();
    } finally {
      setPending(false);
    }
  }
  return (
    <Panel
      id="route-direct"
      className="route-card route-green ipv6-direct-route"
    >
      <div className="route-card-top">
        <div className="route-icon green">
          <Globe2 size={19} />
        </div>
        <div>
          <h3>{route.name}</h3>
          <small>本机原生 IPv6 · Cloudflare DDNS</small>
        </div>
        <Badge tone={route.ready && route.publicIPv6 ? "green" : "amber"}>
          {route.ready && route.publicIPv6
            ? "直连服务就绪"
            : route.running
              ? "等待 IPv6"
              : "已停止"}
        </Badge>
      </div>
      <div className="public-address">
        <span>玩家连接地址 · 需要 IPv6 网络</span>
        <div>
          <strong>{route.domain}</strong>
          <code>{route.httpsPort}</code>
          <IconButton
            label="复制 IPv6 玩家连接信息"
            onClick={() =>
              void navigator.clipboard
                .writeText(`${route.domain}:${route.httpsPort}`)
                .then(() => useApp.getState().toast("连接信息已复制"))
            }
          >
            <Copy size={15} />
          </IconButton>
        </div>
        <small>在游戏中分别填写域名与端口；UDP 数据端口由握手下发。</small>
      </div>
      {route.error && <Notice tone="warn">{route.error}</Notice>}
      <section className="route-section">
        <div className="route-section-heading">
          <h4>直连线路状态</h4>
          <Badge tone={route.ddns?.ok ? "green" : "amber"}>
            DDNS {route.ddns?.ok ? "已同步" : "待检查"}
          </Badge>
        </div>
        <div className="route-facts">
          <div>
            <span>HTTPS 证书</span>
            <strong>
              {certDays === null
                ? "服务未运行"
                : certDays > 0
                  ? `有效 · 剩余 ${certDays} 天`
                  : "证书已到期"}
            </strong>
          </div>
          <div>
            <span>IPv6 传输握手</span>
            <Badge
              tone={transport?.ok && !stale && route.ready ? "green" : "amber"}
            >
              {transport
                ? stale
                  ? "结果已过期"
                  : transport.ok
                    ? "检测通过"
                    : "检测失败"
                : "尚未检测"}
            </Badge>
          </div>
          <div>
            <span>最近检测</span>
            <strong>
              {report ? date(Date.parse(report.testedAt)) : "点击下方检测"}
            </strong>
          </div>
        </div>
      </section>
      <div className="route-card-actions">
        <Button
          disabled={pending}
          onClick={() => void action(route.running ? "stop" : "start")}
        >
          {route.running ? <Square size={14} /> : <Play size={14} />}
          {route.running ? "停止直连" : "启动直连"}
        </Button>
        <Button
          disabled={pending || !route.running}
          onClick={() => void action("restart")}
        >
          <RefreshCw size={14} />
          重启直连
        </Button>
        <Button
          disabled={pending || !route.ready}
          onClick={() => void diagnose()}
        >
          <Globe2 size={14} />
          {pending ? "正在处理…" : "检测 IPv6 线路"}
        </Button>
      </div>
      <Disclosure title="IPv6 地址、证书与传输状态">
        <div className="route-facts">
          <div>
            <span>本机公网 IPv6</span>
            <code>{route.publicIPv6 || "等待网卡获取固定地址"}</code>
          </div>
          <div>
            <span>游戏 UDP 端口</span>
            <strong>{route.udpPort}</strong>
          </div>
          <div>
            <span>HTTPS 证书到期</span>
            <strong>
              {route.certificateExpires
                ? date(Date.parse(route.certificateExpires))
                : "服务未运行"}
            </strong>
          </div>
          <div>
            <span>证书续期</span>
            <strong>{route.certificateRenewal || "服务未运行"}</strong>
          </div>
          <div>
            <span>活动传输会话</span>
            <strong>{route.sessions ?? 0}</strong>
          </div>
          <div>
            <span>直连接收 / 发送</span>
            <strong>
              {bytes(route.receivedBytes || 0)} / {bytes(route.sentBytes || 0)}
            </strong>
          </div>
        </div>
        <p className="muted">
          DDNS 由路由器更新；桌面关闭后直连服务继续运行。停止直连只影响此入口。
        </p>
      </Disclosure>
      {report && (
        <div className="route-facts ipv6-direct-report" aria-live="polite">
          {report.checks.map((check) => (
            <div key={check.name}>
              <span>{check.name}</span>
              <Badge tone={check.ok ? "green" : "amber"}>
                {check.ok ? "通过" : "需要检查"}
              </Badge>
              <small style={{ overflowWrap: "anywhere" }}>{check.detail}</small>
            </div>
          ))}
          <p className="muted">{report.scope}</p>
        </div>
      )}
    </Panel>
  );
}
