import { useState } from "react";
import { Activity, ChevronRight, RefreshCw } from "lucide-react";
import type { Route, RouteQualityReport } from "../../shared/types";
import { date } from "../store";
import { Badge, Button, Drawer, Notice } from "../components";

const ms = (value: number | null | undefined) =>
  value == null ? "—" : `${Math.round(value)} ms`;

export default function RouteQuality({
  route,
  report,
  busy,
  onMeasure,
}: {
  route: Route;
  report: RouteQualityReport | null;
  busy: boolean;
  onMeasure: () => void;
}) {
  const [detail, setDetail] = useState(false);
  const quality = report?.routes.find(
    (r) =>
      r.signalId === route.signalId &&
      r.host === route.host &&
      r.port === route.port,
  );
  const fresh = !!quality && Date.now() - quality.checkedAt < 15 * 60000;
  const recommended = fresh && report?.recommendedSignalId === route.signalId;
  return (
    <div className="route-section route-quality-section">
      <div className="route-section-heading">
        <h4>
          <Activity size={14} />
          线路质量
        </h4>
        {recommended && <Badge tone="green">本机检测优选</Badge>}
        {quality && !fresh && <Badge tone="amber">结果已过期</Badge>}
        <Button disabled={busy} onClick={onMeasure}>
          <RefreshCw size={13} />
          检测本线路
        </Button>
      </div>
      <div className="route-quality-metrics">
        <div>
          <span>信令中位耗时</span>
          <strong>{ms(quality?.medianMs)}</strong>
          <small>P95 {ms(quality?.p95Ms)}</small>
        </div>
        <div>
          <span>响应抖动</span>
          <strong>{ms(quality?.jitterMs)}</strong>
          <small>相邻成功样本差</small>
        </div>
        <div>
          <span>请求失败率</span>
          <strong className={quality?.failureRate ? "danger-text" : ""}>
            {quality ? `${Math.round(quality.failureRate)}%` : "—"}
          </strong>
          <small>
            {quality
              ? `${quality.samples.filter((s) => s.ok).length} / ${quality.samples.length} 成功`
              : "5 次信令采样"}
          </small>
        </div>
        <div>
          <span>UDP 握手与重连</span>
          <Badge
            tone={
              quality?.transport.status === "pass"
                ? "green"
                : quality?.transport.status === "fail"
                  ? "red"
                  : "neutral"
            }
          >
            {quality?.transport.status === "pass"
              ? "重连通过"
              : quality?.transport.status === "fail"
                ? "握手失败"
                : "未验证"}
          </Badge>
          <small>
            {quality?.transport.connectMs != null
              ? `建连 ${ms(quality.transport.connectMs)}`
              : "2 次传输连接"}
          </small>
        </div>
      </div>
      <div className="route-section-footer">
        <small>
          {quality
            ? date(quality.checkedAt)
            : "尚未检测 · 点击本线路检测获取结果"}
        </small>
        <button className="text-button" onClick={() => setDetail(true)}>
          检测详情
          <ChevronRight size={12} />
        </button>
      </div>
      <p className="route-login-scope">
        玩家登录：未按线路验证，需结合游戏连接与玩家日志确认。
      </p>
      <Drawer
        open={detail}
        onClose={() => setDetail(false)}
        title={`${route.name} · 质量详情`}
        description="信令耗时包含 DNS、TLS 和响应时间；传输握手不代表真实玩家登录。"
        wide
      >
        {!quality && (
          <Notice>
            尚无本线路的质量结果。请先点击“检测本线路”；信令请求、UDP
            握手与真实玩家登录将分别显示。
          </Notice>
        )}
        {quality && (
          <>
            <Notice
              tone={quality.transport.status === "fail" ? "warn" : undefined}
            >
              {quality.transport.detail}
            </Notice>
            <div className="quality-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>请求</th>
                    <th>结果</th>
                    <th>耗时</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {quality.samples.map((sample, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{sample.ok ? "成功" : "失败"}</td>
                      <td>{ms(sample.elapsedMs)}</td>
                      <td>{sample.error || "信令返回成功"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="core-update-help">{report?.scope}</p>
            <p className="core-update-help">
              本机检测结果只代表当前电脑到节点的近期测量。这里的请求失败率不等于游戏
              UDP 丢包率，信令耗时不等于游戏内延迟。
            </p>
          </>
        )}
      </Drawer>
    </div>
  );
}
