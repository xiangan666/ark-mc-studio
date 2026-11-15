import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import {
  ArrowUpRight,
  BarChart3,
  Box,
  ChevronRight,
  Globe2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { act, date, useApp } from "./store";
import { groups, isGlobal, navigation, pageInfo } from "./navigation";
import type { Core } from "../shared/types";
import {
  Badge,
  Button,
  Confirm,
  Drawer,
  Empty,
  Loading,
  Modal,
  Notice,
  Toasts,
  VoxelScene,
} from "./components";
import PageBoundary from "./PageBoundary";
import ProgramUpgrade from "./ProgramUpgrade";
import { WorkspaceHeader, WorkspaceSidebar } from "./WorkspaceChrome";
const Dashboard = lazy(() => import("./pages/Dashboard"));
const AnalysisPage = lazy(() => import("./pages/Analysis"));
const ConsolePage = lazy(() => import("./pages/Console"));
const ToolsPage = lazy(() => import("./pages/ToolsPage"));
const InstancesPage = lazy(() => import("./pages/InstancesPage"));
const WorldsPage = lazy(() =>
  import("./pages/ContentPages").then((m) => ({ default: m.WorldsPage })),
);
const PacksPage = lazy(() =>
  import("./pages/ContentPages").then((m) => ({ default: m.PacksPage })),
);
const FilesPage = lazy(() =>
  import("./pages/ContentPages").then((m) => ({ default: m.FilesPage })),
);
const ConfigPage = lazy(() =>
  import("./pages/ContentPages").then((m) => ({ default: m.ConfigPage })),
);
const PlayersPage = lazy(() =>
  import("./pages/Operations").then((m) => ({ default: m.PlayersPage })),
);
const BackupsPage = lazy(() =>
  import("./pages/Operations").then((m) => ({ default: m.BackupsPage })),
);
const NetworkPage = lazy(() =>
  import("./pages/Operations").then((m) => ({ default: m.NetworkPage })),
);
const SchedulesPage = lazy(() =>
  import("./pages/Operations").then((m) => ({ default: m.SchedulesPage })),
);
const TasksPage = lazy(() =>
  import("./pages/Operations").then((m) => ({ default: m.TasksPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/Operations").then((m) => ({ default: m.SettingsPage })),
);
const InstanceDialog = lazy(() =>
  import("./pages/Operations").then((m) => ({ default: m.InstanceDialog })),
);

export default function App() {
  const {
    data,
    selected,
    page,
    error,
    refresh,
    receive,
    navigate,
    select,
    sidebarCollapsed,
    toggleGroup,
    dirty,
    pendingNavigation,
    completeNavigation,
    focusTarget,
  } = useApp(
    useShallow((s) => ({
      data: s.data,
      selected: s.selected,
      page: s.page,
      error: s.error,
      refresh: s.refresh,
      receive: s.receive,
      navigate: s.navigate,
      select: s.select,
      sidebarCollapsed: s.sidebarCollapsed,
      toggleGroup: s.toggleGroup,
      dirty: s.dirty,
      pendingNavigation: s.pendingNavigation,
      completeNavigation: s.completeNavigation,
      focusTarget: s.focusTarget,
    })),
  );
  const density = useApp((s) => s.density);
  const [create, setCreate] = useState(false);
  const [update, setUpdate] = useState<{
    id: string;
    version?: string;
    core?: Core;
  } | null>(null);
  const [palette, setPalette] = useState(false);
  const paletteNavigated = useRef(false);
  const [search, setSearch] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [notices, setNotices] = useState(false);
  const [stop, setStop] = useState(false);
  const [restart, setRestart] = useState(false);
  const navigationKey = useApp((s) => s.navigationKey);
  const systemReduced = useReducedMotion();
  const reduced = !!data?.settings.reducedMotion || !!systemReduced;
  const info = pageInfo(page);
  const global = isGlobal(page);
  const current = data?.instances.find((i) => i.id === selected);
  const snap = data?.snapshots.find((s) => s.id === selected);
  const activeJobs =
    data?.jobs.filter((j) => ["running", "queued"].includes(j.status)) || [];
  useEffect(() => {
    void refresh();
    const remove = window.ark.onEvent(receive);
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 20000);
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((v) => !v);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "`") {
        event.preventDefault();
        navigate("console");
      }
    };
    const visible = (event?: Event) => {
      document.documentElement.dataset.visibility = document.hidden
        ? "hidden"
        : "visible";
      if (event && !document.hidden) void refresh();
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("keydown", key);
    return () => {
      remove();
      clearInterval(timer);
      window.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = data?.settings.theme || "dark";
    document.documentElement.dataset.motion = reduced ? "reduced" : "full";
    document.documentElement.dataset.density = density;
  }, [data?.settings.theme, reduced, density]);
  useEffect(() => {
    if (!focusTarget) {
      document.querySelector("main")?.scrollTo({ top: 0 });
      return;
    }
    let finished = false;
    const focus = () => {
      if (finished || document.querySelector('[role="dialog"]')) return;
      const element = document.getElementById(focusTarget);
      const main = document.querySelector("main");
      if (!element || !main || !element.getClientRects().length) return;
      main.scrollTo({
        top:
          main.scrollTop +
          element.getBoundingClientRect().top -
          main.getBoundingClientRect().top -
          24,
        behavior: reduced ? "instant" : "smooth",
      });
      const target = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ),
      ].find((item) => item.getClientRects().length);
      if (target) target.focus({ preventScroll: true });
      else {
        element.tabIndex = -1;
        element.focus({ preventScroll: true });
      }
      finished = true;
      observer.disconnect();
    };
    const observer = new MutationObserver(focus);
    // Dialog portals live outside main; wait for their focus scope to close too.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "data-state"],
    });
    const timer = setTimeout(focus, 320);
    const deadline = setTimeout(() => observer.disconnect(), 10000);
    return () => {
      finished = true;
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(deadline);
    };
  }, [page, selected, focusTarget, navigationKey]);
  useEffect(() => {
    setPaletteIndex(0);
  }, [search]);
  useEffect(() => {
    if (!useApp.getState().openGroups.includes(info.group))
      toggleGroup(info.group);
  }, [page]);
  const openInstance = (id: string) => {
    if (useApp.getState().dirty) {
      useApp.setState({
        pendingNavigation: { instance: id, page: "overview" },
      });
      return;
    }
    select(id);
    navigate("overview");
  };
  const actions = [
    {
      label: "运行分析与趋势",
      description: "只读 / 性能统计、日志归类、运维观察与导出",
      icon: BarChart3,
      run: () => navigate("analysis"),
    },
    {
      label: "核心检查与更新",
      description: "首页 / 版本、兼容组合与更新策略",
      icon: RefreshCw,
      run: () => navigate("overview", "core-updates"),
    },
    {
      label: "线路质量与连接检测",
      description: "网络线路 / 信令、握手与重连检测结果",
      icon: Globe2,
      run: () => navigate("network", "network-diagnostics"),
    },
    {
      label: "统一信令转接",
      description: "网络线路 / 上游配置与独立 UDP 映射",
      icon: Globe2,
      run: () => navigate("network", "network-signaling"),
    },
    {
      label: "穿透客户端进程与日志",
      description: "网络线路 / 客户端启停、独立 UDP 与进程日志",
      icon: Globe2,
      run: () => navigate("network", "network-clients"),
    },
    {
      label: "新建或关联实例",
      description: "工作空间 / 添加服务器",
      icon: Plus,
      run: () => setCreate(true),
    },
  ];
  const term = search.toLowerCase().trim();
  const results = [
    ...actions
      .filter((a) => `${a.label} ${a.description}`.toLowerCase().includes(term))
      .map((a) => ({ ...a, key: a.label })),
    ...navigation
      .filter((n) =>
        `${n.label} ${n.keywords} ${groups[n.group]}`
          .toLowerCase()
          .includes(term),
      )
      .map((n) => ({
        key: n.page,
        label: n.label,
        description: groups[n.group],
        icon: n.icon,
        run: () => navigate(n.page),
      })),
    ...(data?.instances || [])
      .filter((i) => i.name.toLowerCase().includes(term))
      .map((i) => ({
        key: i.id,
        label: i.name,
        description: `服务器实例 · ${i.core}`,
        icon: Box,
        run: () => openInstance(i.id),
      })),
  ];
  const runResult = (index: number) => {
    const result = results[index];
    if (!result) return;
    const previousKey = useApp.getState().navigationKey;
    result.run();
    const next = useApp.getState();
    paletteNavigated.current =
      next.navigationKey !== previousKey && !!next.focusTarget;
    setPalette(false);
    setSearch("");
  };
  const content = () => {
    if (!data)
      return (
        <Empty
          title="暂时无法连接后台"
          description="重新连接后会恢复服务器状态与任务数据。"
        />
      );
    if (page === "settings") return <SettingsPage />;
    if (page === "tasks") return <TasksPage />;
    if (page === "tools") return <ToolsPage />;
    if (page === "instances")
      return <InstancesPage onCreate={() => setCreate(true)} />;
    if (!current)
      return (
        <div className="welcome">
          <div className="welcome-copy">
            <Badge tone="green">YOUR NEXT WORLD</Badge>
            <h1>
              让每个世界，
              <br />
              <em>都有序生长。</em>
            </h1>
            <p>
              关联已有服务器，或从官方来源创建新的世界。
              <br />
              数据、运行环境与网络线路，在这里集中管理。
            </p>
            <Button variant="primary" onClick={() => setCreate(true)}>
              <Plus size={17} />
              添加第一台服务器
              <ArrowUpRight size={16} />
            </Button>
          </div>
          <VoxelScene />
        </div>
      );
    switch (page) {
      case "overview":
        return (
          <Dashboard
            onUpdate={(version, core) =>
              setUpdate({ id: selected, version, core })
            }
          />
        );
      case "console":
        return <ConsolePage />;
      case "analysis":
        return <AnalysisPage />;
      case "players":
        return <PlayersPage />;
      case "worlds":
        return <WorldsPage />;
      case "packs":
        return <PacksPage />;
      case "files":
        return <FilesPage />;
      case "config":
        return <ConfigPage />;
      case "backups":
        return <BackupsPage />;
      case "network":
        return <NetworkPage />;
      case "schedules":
        return <SchedulesPage />;
    }
  };
  if (data?.programUpdating) return <ProgramUpgrade />;
  return (
    <MotionConfig
      reducedMotion={reduced ? "always" : "never"}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      <div
        className={`app-shell studio-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      >
        <WorkspaceSidebar />
        <div className="workspace">
          <WorkspaceHeader
            onPalette={() => setPalette(true)}
            onNotices={() => setNotices(true)}
            onStop={() => setStop(true)}
            onRestart={() => setRestart(true)}
          />
          <main className="main-scroll">
            {error && (
              <Notice tone="warn">
                {error}
                <Button onClick={() => void refresh()}>重新连接</Button>
              </Notice>
            )}
            {!data && !error ? (
              <div className="startup">
                <Box className="float" size={40} />
                <h2>正在连接工作空间</h2>
                <p>读取服务器、线路和后台任务…</p>
              </div>
            ) : (
              <motion.div
                className="page-transition"
                key={`${page}:${global ? "workspace" : selected}`}
                initial={reduced ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <PageBoundary
                  key={`${page}:${global ? "workspace" : selected}`}
                >
                  <Suspense fallback={<Loading />}>{content()}</Suspense>
                </PageBoundary>
              </motion.div>
            )}
          </main>
          <footer className="statusbar">
            <div>
              <span className={`small-dot ${!error && data ? "green" : ""}`} />
              {error ? "连接需要处理" : data ? "后台已连接" : "正在连接后台"}
              <span className="statusbar-separator" />
              程序版本 {window.ark.versions.app}
            </div>
            <button onClick={() => navigate("tasks")}>
              {activeJobs.length ? (
                <>
                  <span className="small-spinner" />
                  {activeJobs[0].title}
                  <span>{Math.round(activeJobs[0].progress)}%</span>
                </>
              ) : (
                <>
                  <ShieldCheck size={12} />
                  {data ? "后台任务已同步" : "等待同步任务"}
                </>
              )}
              <ChevronRight size={12} />
            </button>
          </footer>
        </div>
        <Toasts />
        {create && (
          <Suspense fallback={null}>
            <InstanceDialog open={create} onClose={() => setCreate(false)} />
          </Suspense>
        )}
        {!!update && (
          <Suspense fallback={null}>
            <InstanceDialog
              open={!!update}
              onClose={() => setUpdate(null)}
              updateId={update?.id}
              suggestedVersion={update?.version}
              suggestedCore={update?.core}
            />
          </Suspense>
        )}
        <Confirm
          open={stop}
          onClose={() => setStop(false)}
          title="正常保存并关闭服务器"
          description={`保存「${snap?.world || current?.name}」并断开在线玩家。隧道继续运行。`}
          danger
          label="保存并关闭"
          onConfirm={async () => {
            await act(
              "server.action",
              { id: selected, action: "stop" },
              "关服任务已排队",
            );
          }}
        />
        <Confirm
          open={restart}
          onClose={() => setRestart(false)}
          title="计划重启服务器"
          description="向玩家发送 30 秒倒计时，正常保存关服后重新启动。"
          label="30 秒后重启"
          onConfirm={async () => {
            await act(
              "server.action",
              { id: selected, action: "restart", countdown: 30 },
              "重启任务已排队",
            );
          }}
        />
        <Confirm
          open={!!pendingNavigation}
          onClose={() => useApp.setState({ pendingNavigation: null })}
          title="离开前保留修改"
          description={`「${dirty}」有未保存内容。可返回保存，或放弃修改后继续。`}
          danger
          label="放弃修改并继续"
          onConfirm={completeNavigation}
        />
        <Modal
          open={palette}
          onClose={() => setPalette(false)}
          onCloseAutoFocus={(event) => {
            if (!paletteNavigated.current) return;
            event.preventDefault();
            paletteNavigated.current = false;
            useApp.setState((state) => ({
              navigationKey: state.navigationKey + 1,
            }));
          }}
          title="命令与导航"
          description="搜索功能、服务器和常用操作；方向键选择，Enter 打开。"
        >
          <div className="palette-search">
            <Search size={19} />
            <input
              autoFocus
              aria-label="搜索全部功能"
              role="combobox"
              aria-expanded={palette}
              aria-autocomplete="list"
              aria-controls="palette-results"
              aria-activedescendant={
                results[paletteIndex]
                  ? `palette-result-${paletteIndex}`
                  : undefined
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="试试：核心更新、信令、备份…"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPaletteIndex((i) => Math.min(results.length - 1, i + 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPaletteIndex((i) => Math.max(0, i - 1));
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  runResult(paletteIndex);
                }
              }}
            />
            <kbd>Esc</kbd>
          </div>
          <div
            className="palette-results"
            id="palette-results"
            role="listbox"
            aria-label="功能搜索结果"
          >
            {results.map((r, i) => (
              <button
                key={r.key}
                id={`palette-result-${i}`}
                role="option"
                aria-selected={paletteIndex === i}
                className={paletteIndex === i ? "selected" : ""}
                onMouseEnter={() => setPaletteIndex(i)}
                onClick={() => runResult(i)}
              >
                <r.icon size={18} />
                <span>
                  <strong>{r.label}</strong>
                  <small>{r.description}</small>
                </span>
                <ArrowUpRight size={15} />
              </button>
            ))}
            {!results.length && (
              <Empty
                title="没有找到相关功能"
                description="试试功能名、实例名或操作关键词。"
              />
            )}
          </div>
        </Modal>
        <Drawer
          open={notices}
          onClose={() => setNotices(false)}
          title="活动与通知"
          description="服务器和管理操作的实际记录。"
        >
          <div className="notification-list">
            {data?.activities.length ? (
              data.activities.slice(0, 50).map((a) => (
                <div key={a.id}>
                  <span className={`activity-dot ${a.level}`} />
                  <div>
                    <p>{a.text}</p>
                    <small>{date(a.at)}</small>
                  </div>
                </div>
              ))
            ) : (
              <Empty title="暂时没有活动" />
            )}
          </div>
          <Button
            onClick={() => {
              setNotices(false);
              navigate("tasks");
            }}
          >
            查看全部记录
            <ChevronRight size={14} />
          </Button>
        </Drawer>
      </div>
    </MotionConfig>
  );
}
