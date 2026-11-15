import {
  ArrowDownToLine,
  ArrowRight,
  Copy,
  LayoutGrid,
  List,
} from "lucide-react";
import {
  Badge,
  Button,
  Empty,
  IconButton,
  Panel,
  SearchInput,
} from "../components";
import { date, message, useApp } from "../store";
import { transportLabel, type RouteRow, type RouteFilter } from "../analysis";

export { selectRoutes, type RouteFilter } from "../analysis";
export function NetworkToolbar({
  rows,
  search,
  onSearch,
  filter,
  onFilter,
  view,
  onView,
}: {
  rows: RouteRow[];
  search: string;
  onSearch: (value: string) => void;
  filter: RouteFilter;
  onFilter: (value: RouteFilter) => void;
  view: "cards" | "overview";
  onView: (value: "cards" | "overview") => void;
}) {
  async function exportAddresses() {
    try {
      const value = rows
        .map(
          (row) =>
            `${row.name}\r\n地址：${row.address}\r\n${row.kind === "direct" ? "需要客户端具备 IPv6 网络" : "信令与 UDP 分别验证"}\r\n`,
        )
        .join("\r\n");
      const saved = await window.ark.saveFile("ArkMC-玩家入口.txt", value);
      if (saved) useApp.getState().toast("玩家入口已导出，不包含客户端令牌");
    } catch (e) {
      useApp.getState().toast(message(e), "error");
    }
  }
  return (
    <div className="network-toolbar toolbar-surface">
      <SearchInput
        value={search}
        onChange={onSearch}
        placeholder="搜索线路名或玩家地址…"
      />
      <select
        aria-label="筛选玩家入口"
        className="compact-select"
        value={filter}
        onChange={(e) => onFilter(e.target.value as RouteFilter)}
      >
        <option value="all">全部入口</option>
        <option value="attention">需要检查</option>
        <option value="unverified">未验证 / 已过期</option>
        <option value="direct">本机 IPv6</option>
      </select>
      <div className="segmented route-view-switch" aria-label="线路展示方式">
        <button
          className={view === "cards" ? "active" : ""}
          aria-pressed={view === "cards"}
          onClick={() => onView("cards")}
        >
          <LayoutGrid size={14} />
          管理卡片
        </button>
        <button
          className={view === "overview" ? "active" : ""}
          aria-pressed={view === "overview"}
          onClick={() => onView("overview")}
        >
          <List size={14} />
          紧凑总览
        </button>
      </div>
      <Button
        variant="ghost"
        disabled={!rows.length}
        onClick={() => void exportAddresses()}
      >
        <ArrowDownToLine size={14} />
        导出入口
      </Button>
    </div>
  );
}
export default function NetworkOverview({
  rows,
  onManage,
}: {
  rows: RouteRow[];
  onManage: (key: string) => void;
}) {
  return (
    <Panel className="network-overview">
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>玩家入口</th>
              <th>进程状态</th>
              <th>传输检测</th>
              <th>信令耗时</th>
              <th>管理</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <strong>{row.name}</strong>
                  <div className="route-address-line">
                    <code>{row.address}</code>
                    <IconButton
                      label={`复制 ${row.name} 地址`}
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(row.address)
                          .then(() => useApp.getState().toast("玩家地址已复制"))
                          .catch((e) =>
                            useApp.getState().toast(message(e), "error"),
                          )
                      }
                    >
                      <Copy size={13} />
                    </IconButton>
                  </div>
                  <small className="muted">
                    {row.kind === "direct"
                      ? "本机 IPv6 · 客户端需具备 IPv6"
                      : "隧道入口"}
                  </small>
                </td>
                <td>
                  <Badge tone={row.running ? "green" : "amber"}>
                    {row.running ? "进程就绪" : "待检查"}
                  </Badge>
                </td>
                <td>
                  <Badge
                    tone={
                      row.transport === "pass"
                        ? "green"
                        : row.transport === "fail"
                          ? "red"
                          : "neutral"
                    }
                  >
                    {transportLabel[row.transport]}
                  </Badge>
                  <div className="cell-sub">{date(row.checkedAt)}</div>
                </td>
                <td>
                  {row.medianMs != null
                    ? `${Math.round(row.medianMs)} ms`
                    : "—"}
                  <div className="cell-sub">
                    {row.kind === "direct"
                      ? "使用独立直连检测"
                      : "最近信令中位耗时"}
                  </div>
                </td>
                <td>
                  <Button variant="ghost" onClick={() => onManage(row.key)}>
                    管理详情
                    <ArrowRight size={13} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <Empty
          title="没有匹配的玩家入口"
          description="调整关键词或筛选条件。"
        />
      )}
      <p className="analysis-disclaimer">
        这里仅汇总已有状态，不执行检测或自动切换入口。信令耗时不等于游戏延迟；传输握手不代表真实玩家登录。
      </p>
    </Panel>
  );
}
