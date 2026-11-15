import { useShallow } from "zustand/react/shallow";
import {
  Bell,
  Box,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Maximize2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Rows3,
  Search,
  Server,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { act, useApp } from "./store";
import { groups, isGlobal, navigation, pageInfo } from "./navigation";
import { Badge, Button, IconButton, Status } from "./components";

/** Stable workspace navigation. Instance selection always has one visible home. */
export function WorkspaceSidebar() {
  const {
    data,
    selected,
    page,
    navigate,
    select,
    sidebarCollapsed,
    openGroups,
    toggleGroup,
    toggleSidebar,
  } = useApp(
    useShallow((s) => ({
      data: s.data,
      selected: s.selected,
      page: s.page,
      navigate: s.navigate,
      select: s.select,
      sidebarCollapsed: s.sidebarCollapsed,
      openGroups: s.openGroups,
      toggleGroup: s.toggleGroup,
      toggleSidebar: s.toggleSidebar,
    })),
  );
  const snapshot = data?.snapshots.find((s) => s.id === selected);
  const activeJobs =
    data?.jobs.filter((j) => ["running", "queued"].includes(j.status)).length ||
    0;
  return (
    <aside className="sidebar">
      <div className="brand drag">
        <div className="brand-icon">
          <Box size={23} />
        </div>
        <div className="brand-copy">
          <strong>
            方舟 <span>MC</span>
          </strong>
          <small>ARKMC STUDIO</small>
        </div>
        <Badge>{window.ark.versions.app}</Badge>
      </div>
      <div className="instance-switcher">
        <div className="instance-switcher-label">
          <span>当前服务器</span>
          <IconButton
            label="管理所有实例"
            onClick={() => navigate("instances")}
          >
            <Settings2 size={14} />
          </IconButton>
        </div>
        <div className="instance-select">
          <Server size={17} />
          <select
            aria-label="选择服务器实例"
            value={selected}
            onChange={(e) => select(e.target.value)}
          >
            {!data?.instances.length && <option value="">尚未添加实例</option>}
            {data?.instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
              </option>
            ))}
          </select>
        </div>
        <div className="instance-switcher-meta">
          <span className={`small-dot ${snapshot?.pid ? "green" : ""}`} />
          <span>{snapshot?.pid ? "正在运行" : "未运行"}</span>
          <span>{data?.instances.length || 0} 个实例</span>
        </div>
      </div>
      <button
        className="collapsed-instance"
        title="管理所有实例"
        aria-label="切换或管理实例"
        onClick={() => navigate("instances")}
      >
        <Server size={19} />
      </button>
      <nav aria-label="功能导航">
        {groups.map((group, index) => {
          const expanded = openGroups.includes(index);
          return (
            <div
              className={`nav-group ${expanded ? "expanded" : ""} ${index === 3 ? "workspace-navigation" : ""}`}
              key={group}
            >
              <button
                className="nav-group-label"
                onClick={() => toggleGroup(index)}
                aria-expanded={expanded}
                aria-label={group}
              >
                <span>{group}</span>
                <ChevronDown size={12} />
              </button>
              <div
                className="nav-group-items"
                hidden={!expanded && !sidebarCollapsed}
              >
                {navigation
                  .filter((item) => item.group === index)
                  .map((item) => (
                    <button
                      key={item.page}
                      data-page={item.page}
                      className={`nav-item ${page === item.page ? "active" : ""}`}
                      aria-current={page === item.page ? "page" : undefined}
                      title={item.label}
                      onClick={() => navigate(item.page)}
                    >
                      <item.icon size={17} />
                      <span>{item.label}</span>
                      {item.page === "players" &&
                        !!snapshot?.metric.players && (
                          <small>{snapshot.metric.players}</small>
                        )}
                      {item.page === "tasks" && activeJobs > 0 && (
                        <small>{activeJobs}</small>
                      )}
                    </button>
                  ))}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="sidebar-collapse"
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
          <span>收起导航</span>
        </button>
        <span className="sidebar-platform">Windows x64</span>
      </div>
    </aside>
  );
}

export function WorkspaceHeader({
  onPalette,
  onNotices,
  onStop,
  onRestart,
}: {
  onPalette: () => void;
  onNotices: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const { data, selected, page, density, setDensity } = useApp(
    useShallow((s) => ({
      data: s.data,
      selected: s.selected,
      page: s.page,
      density: s.density,
      setDensity: s.setDensity,
    })),
  );
  const instance = data?.instances.find((i) => i.id === selected);
  const snapshot = data?.snapshots.find((s) => s.id === selected);
  const global = isGlobal(page);
  const busy =
    ["starting", "stopping"].includes(snapshot?.status || "") ||
    !!data?.jobs.some(
      (j) =>
        j.instanceId === selected && ["running", "queued"].includes(j.status),
    );
  return (
    <header className="topbar drag">
      <div
        className="workspace-context"
        data-scope={global ? "workspace" : "instance"}
      >
        <span className="scope-label">
          {global ? "工作空间" : instance?.name || "服务器工作台"}
        </span>
        <ChevronRight size={13} />
        <span>{pageInfo(page).label}</span>
      </div>
      <div className="topbar-tools no-drag">
        {!global && instance && (
          <div className="server-actions">
            <Status status={snapshot?.status || "unknown"} />
            <IconButton
              label="打开实例目录"
              onClick={() => void window.ark.reveal(instance.root)}
            >
              <FolderOpen size={15} />
            </IconButton>
            <IconButton
              label="重启服务器"
              disabled={
                !snapshot?.pid || busy || !snapshot.capabilities.command
              }
              onClick={onRestart}
            >
              <RefreshCw size={15} />
            </IconButton>
            {snapshot?.pid ? (
              <Button
                variant="danger"
                disabled={busy || !snapshot.capabilities.command}
                onClick={onStop}
              >
                <Square size={12} />
                正常关服
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy || !data?.samplerReady}
                onClick={() =>
                  void act(
                    "server.action",
                    {
                      id: selected,
                      action: "start",
                      tunnels: !!instance.tunnelRoot,
                    },
                    "启动任务已排队",
                  )
                }
              >
                <Play size={13} />
                启动服务器
              </Button>
            )}
          </div>
        )}
        <button
          className="command-trigger"
          aria-label="搜索功能、实例与操作"
          title="搜索功能、实例与操作 (Ctrl+K)"
          onClick={onPalette}
        >
          <Search size={16} />
          <kbd>Ctrl K</kbd>
        </button>
        <IconButton label="活动与通知" onClick={onNotices}>
          <Bell size={17} />
        </IconButton>
        <IconButton
          label={density === "compact" ? "切换为舒适布局" : "切换为紧凑布局"}
          onClick={() =>
            setDensity(density === "compact" ? "comfortable" : "compact")
          }
        >
          <Rows3 size={17} />
        </IconButton>
        <div className="window-controls">
          <button
            aria-label="最小化"
            onClick={() => window.ark.window("minimize")}
          >
            <Minus size={15} />
          </button>
          <button
            aria-label="最大化或还原"
            onClick={() => window.ark.window("maximize")}
          >
            <Maximize2 size={14} />
          </button>
          <button
            className="window-close"
            aria-label="关闭并缩到托盘"
            onClick={() => window.ark.window("close")}
          >
            <X size={17} />
          </button>
        </div>
      </div>
    </header>
  );
}
