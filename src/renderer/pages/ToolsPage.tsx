import WorkspaceUpgrade from "./WorkspaceUpgrade";
import { useState } from "react";
import {
  Download,
  FolderOpen,
  Package,
  RefreshCw,
  Wrench,
  Box,
  ArrowRight,
  Cpu,
} from "lucide-react";
import type { ToolInfo } from "../../shared/types";
import { act, useApp } from "../store";
import {
  Badge,
  Button,
  Heading,
  Notice,
  Panel,
  PageTabs,
  tabPanelProps,
  QueryError,
  Loading,
  useQuery,
} from "../components";

interface ToolData {
  root: string;
  items: ToolInfo[];
  environments: {
    id: string;
    name: string;
    python: string;
    managed: boolean;
  }[];
  instances: {
    id: string;
    name: string;
    root: string;
    tunnelRoot?: string;
    managed: boolean;
  }[];
}
export default function ToolsPage() {
  const q = useQuery<ToolData>("tools.list", {}, 15000);
  const [checking, setChecking] = useState(false);
  const [tab, setTab] = useState("clients");
  const { data, navigate } = useApp();
  const busy = data?.jobs.some(
    (j) => j.type === "tools" && ["running", "queued"].includes(j.status),
  );
  async function check() {
    setChecking(true);
    try {
      const result = await act<ToolData>("tools.list", { check: true });
      if (result) q.setData(result);
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="page tools-page">
      <Heading
        eyebrow="EVERY TOOL, ONE HOME"
        title="工具与环境"
        description="第三方客户端与运行环境统一管理，让服务器核心目录保持清晰。"
        actions={
          <>
            <Button
              onClick={() => q.data && void window.ark.reveal(q.data.root)}
            >
              <FolderOpen size={15} />
              工具目录
            </Button>
            <Button
              variant="primary"
              disabled={checking}
              onClick={() => void check()}
            >
              <RefreshCw size={15} className={checking ? "spin" : ""} />
              {checking ? "正在检查官方版本…" : "检查更新"}
            </Button>
          </>
        }
      />
      {q.error && <QueryError error={q.error} retry={q.reload} />}
      <PageTabs
        id="tools"
        label="工具功能分类"
        value={tab}
        onChange={setTab}
        items={[
          { value: "clients", label: "穿透客户端" },
          { value: "runtime", label: "运行环境" },
          { value: "archive", label: "实例工具归档" },
          { value: "maintenance", label: "版本整理" },
        ]}
      />
      <div {...tabPanelProps("tools", tab)} className="tab-content">
        {tab === "maintenance" && (
          <>
            <Panel
              title="版本数据与目录整理"
              subtitle="检查客户端登记和未使用的历史运行时，保留活动资源与回退资源。"
            >
              <WorkspaceUpgrade />
            </Panel>
            <Notice>
              检查不会删除服务器世界、数据库、备份、凭证或未知目录。运行中的游戏与线路不因整理操作而停止。
            </Notice>
          </>
        )}
        {data?.jobs
          .filter(
            (j) =>
              j.type === "tools" && ["running", "queued"].includes(j.status),
          )
          .map((j) => (
            <div className="network-quality-progress" key={j.id}>
              <Download size={16} />
              <div>
                <strong>{j.detail}</strong>
                <div className="progress-track">
                  <span style={{ width: `${j.progress}%` }} />
                </div>
              </div>
              <span>{Math.round(j.progress)}%</span>
              <Button onClick={() => navigate("tasks")}>查看任务</Button>
            </div>
          ))}
        {tab !== "maintenance" && (
          <div className="tool-root-line">
            <FolderOpen size={15} />
            <code>{q.data?.root || "正在读取工具目录…"}</code>
            <span>
              {q.data?.items.filter((tool) => tool.updateAvailable).length || 0}{" "}
              项可更新
            </span>
          </div>
        )}
        {q.loading && !q.data && <Loading />}
        {tab !== "archive" && tab !== "maintenance" && (
          <div className="tool-grid">
            {q.data?.items
              .filter((t) =>
                tab === "runtime" ? t.tool === "uv" : t.tool !== "uv",
              )
              .map((tool) => (
                <Panel key={tool.tool} className="tool-card">
                  <div className="tool-card-head">
                    <span className={`tool-glyph tool-${tool.tool}`}>
                      {tool.tool === "uv" ? (
                        <Cpu size={25} />
                      ) : (
                        <Package size={25} />
                      )}
                    </span>
                    <Badge
                      tone={
                        tool.updateAvailable
                          ? "purple"
                          : tool.installedVersion
                            ? "green"
                            : "neutral"
                      }
                    >
                      {tool.updateAvailable
                        ? "有新版本"
                        : tool.installedVersion
                          ? "已安装"
                          : "按需安装"}
                    </Badge>
                  </div>
                  <h2>{tool.name}</h2>
                  <p>
                    {tool.tool === "lolia"
                      ? "支持 Lolia 信令、UDP 隧道与自动证书。下载后由网络页面管理线路。"
                      : tool.tool === "sakura"
                        ? "樱花官方专用客户端，支持自动 HTTPS 信令与 UDP。可与 Lolia 多条线路同时运行。"
                        : tool.tool === "frp"
                          ? "官方通用客户端，供自建 FRP 服务使用。与 Lolia 客户端独立存放。"
                          : "下载 Python、创建独立环境及安装 Endstone。各实例的依赖互相隔离。"}
                  </p>
                  <dl className="tool-versions">
                    <div>
                      <dt>当前版本</dt>
                      <dd>
                        {tool.installedVersion || "尚未安装"}
                        {tool.bundled ? " · 随应用提供" : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>官方稳定版</dt>
                      <dd>{tool.latestVersion || "点击检查更新"}</dd>
                    </div>
                  </dl>
                  {tool.error && <Notice tone="warn">{tool.error}</Notice>}
                  <small className="muted tool-path">
                    {tool.executable || tool.source}
                  </small>
                  <Button
                    variant={tool.tool === "lolia" ? "primary" : "default"}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        "tools.install",
                        { tool: tool.tool },
                        "已加入任务中心，完成后自动生效于下次启动",
                      )
                    }
                  >
                    <Download size={15} />
                    {tool.updateAvailable
                      ? "下载并更新"
                      : tool.installedVersion
                        ? "一键安装官方最新版"
                        : "一键下载并安装"}
                    <ArrowRight size={15} />
                  </Button>
                </Panel>
              ))}
          </div>
        )}
        {tab === "archive" && (
          <Panel
            title="实例工具归档"
            subtitle="已有服务器正常关闭、关联隧道停止后，可一键迁移到管理程序目录。地图、模组和核心配置继续留在实例目录。"
          >
            {q.data?.instances.map((i) => (
              <div className="tool-instance" key={i.id}>
                <span className="tool-glyph">
                  <Box size={23} />
                </span>
                <div className="tool-instance-copy">
                  <strong>{i.name}</strong>
                  <small className="tool-path">核心：{i.root}</small>
                  <small className="tool-path">
                    网络：{i.tunnelRoot || "导入隧道后自动创建独立配置目录"}
                  </small>
                </div>
                <Badge tone={i.managed ? "green" : "amber"}>
                  {i.managed ? "已集中管理" : "待整理"}
                </Badge>
                <Button
                  disabled={
                    busy || !!data?.snapshots.find((s) => s.id === i.id)?.pid
                  }
                  onClick={() =>
                    void act("tools.organize", { id: i.id }, "整理任务已提交")
                  }
                >
                  <Wrench size={14} />
                  {i.managed ? "检查与整理" : "迁移并接管"}
                </Button>
              </div>
            ))}
            {!q.data?.instances.length && (
              <p className="muted">
                添加服务器后，可在此管理各实例的运行环境。
              </p>
            )}
          </Panel>
        )}
        {tab === "runtime" && (
          <Panel
            title="运行环境"
            subtitle="Endstone 的独立 Python 环境由核心安装与更新流程准备，使用官方兼容版本。"
            aside={
              <Button
                disabled={busy}
                onClick={() =>
                  void act(
                    "tools.router-runtime",
                    {},
                    "通用转接层运行环境准备任务已提交",
                  )
                }
              >
                <Download size={14} />
                一键准备 / 更新信令环境
              </Button>
            }
          >
            {q.data?.environments.map((env) => (
              <div className="tool-instance" key={env.id}>
                <Cpu size={21} />
                <div className="tool-instance-copy">
                  <strong>{env.name} · Python 3.13 / Endstone</strong>
                  <small className="tool-path">{env.python}</small>
                </div>
                <Badge tone={env.managed ? "green" : "amber"}>
                  {env.managed ? "独立托管" : "核心目录内"}
                </Badge>
              </div>
            ))}
            <p className="muted">
              Node 与桌面组件随方舟 MC 一起更新。Python 与 Endstone
              通过首页的核心更新流程同步检查兼容关系。
            </p>
          </Panel>
        )}
        {tab === "clients" && (
          <Notice>
            工具更新使用官方来源、文件长度及官方摘要校验，安装后记录本地
            SHA-256。 樱花发行源提供 MD5，其他工具提供
            SHA-256。下载或校验失败会保留现用版本；运行中的线路在重新加载后使用新客户端。
            <Button variant="ghost" onClick={() => navigate("network")}>
              管理网络线路
              <ArrowRight size={14} />
            </Button>
          </Notice>
        )}
      </div>
    </div>
  );
}
