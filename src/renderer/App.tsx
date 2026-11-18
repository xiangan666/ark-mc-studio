import { lazy, Suspense, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { motion, MotionConfig } from "motion/react";
import { useMotionPreference } from "./use-motion-preference";
import {
  FolderOpen,
  Layers3,
  Box,
  ChevronRight,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { act, date, useApp } from "./store";
import { isGlobal, pageInfo } from "./navigation";
import CommandPalette from "./CommandPalette";
import type { Core } from "../shared/types";
import {
  Button,
  Confirm,
  Drawer,
  Empty,
  Loading,
  Notice,
  Toasts,
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
      sidebarCollapsed: s.sidebarCollapsed,
      toggleGroup: s.toggleGroup,
      dirty: s.dirty,
      pendingNavigation: s.pendingNavigation,
      completeNavigation: s.completeNavigation,
      focusTarget: s.focusTarget,
    })),
  );
  const density = useApp((s) => s.density);
  const [create, setCreate] = useState<"import" | "create" | null>(null);
  const [update, setUpdate] = useState<{
    id: string;
    version?: string;
    core?: Core;
  } | null>(null);
  const [palette, setPalette] = useState(false);
  const [notices, setNotices] = useState(false);
  const [stop, setStop] = useState(false);
  const [restart, setRestart] = useState(false);
  const navigationKey = useApp((s) => s.navigationKey);
  const reduced = useMotionPreference();
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
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
        return;
      if (
        document.querySelector('[role="dialog"]') &&
        !document.getElementById("palette-results")
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((v) => !v);
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "`" &&
        !document.querySelector('[role="dialog"]')
      ) {
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
        behavior:
          document.documentElement.dataset.motion === "reduced"
            ? "instant"
            : "smooth",
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
    if (!useApp.getState().openGroups.includes(info.group))
      toggleGroup(info.group);
  }, [page]);
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
      return <InstancesPage onCreate={() => setCreate("import")} />;
    if (!current)
      return (
        <div className="welcome">
          <div className="welcome-copy">
            <span className="welcome-mark" aria-hidden="true">
              <Layers3 size={28} />
            </span>
            <h1>服务器工作台</h1>
            <p>当前工作空间尚无服务器实例。</p>
            <div className="welcome-actions">
              <Button variant="primary" onClick={() => setCreate("import")}>
                <FolderOpen size={16} />
                关联已有目录
              </Button>
              <Button onClick={() => setCreate("create")}>
                <Plus size={16} />
                创建新实例
              </Button>
            </div>
          </div>
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
      transition={{ duration: reduced ? 0 : 0.19, ease: [0.22, 1, 0.36, 1] }}
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
          <main className="main-scroll" tabIndex={-1} aria-label={info.label}>
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
            <InstanceDialog
              open
              initialMode={create}
              onClose={() => setCreate(null)}
            />
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
        <CommandPalette
          open={palette}
          onClose={() => setPalette(false)}
          onCreate={() => setCreate("import")}
        />
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
