import { create } from "zustand";
import type {
  AgentEvent,
  Bootstrap,
  Job,
  LogLine,
  Snapshot,
} from "../shared/types";
import { jobWindow } from "../shared/job-window";
import { isGlobal, navigation, readPreference, type Page } from "./navigation";
import { recentKey, recentKeys, rememberCommand } from "./command-search";
export type { Page } from "./navigation";
export interface Toast {
  id: number;
  text: string;
  kind: "success" | "error" | "info";
}
interface State {
  data: Bootstrap | null;
  selected: string;
  page: Page;
  error: string;
  revision: number;
  logs: Record<string, LogLine[]>;
  toasts: Toast[];
  dirty: string;
  pendingNavigation: {
    page?: Page;
    instance?: string;
    target?: string;
    commandKey?: string;
  } | null;
  recentCommands: string[];
  recordCommand: (key: string | null) => void;
  focusTarget: string;
  navigationKey: number;
  sidebarCollapsed: boolean;
  openGroups: number[];
  density: "comfortable" | "compact";
  setDensity: (density: "comfortable" | "compact") => void;
  toggleSidebar: () => void;
  toggleGroup: (group: number) => void;
  completeNavigation: () => void;
  refresh: () => Promise<void>;
  select: (id: string) => void;
  navigate: (page: Page, target?: string) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  receive: (event: AgentEvent) => void;
  mergeLogs: (id: string, lines: LogLine[]) => void;
}
export const useApp = create<State>((set, get) => ({
  data: null,
  selected: localStorage.getItem("ark.instance") || "",
  page: (() => {
    const saved = readPreference<Record<string, Page>>(
      "ark.instance-pages",
      {},
    )[localStorage.getItem("ark.instance") || ""];
    return navigation.some((n) => n.page === saved) ? saved : "overview";
  })(),
  error: "",
  revision: 0,
  logs: {},
  toasts: [],
  dirty: "",
  pendingNavigation: null,
  recentCommands: recentKeys(readPreference(recentKey, [])),
  recordCommand: (key) => {
    const recentCommands =
      key === null ? [] : rememberCommand(get().recentCommands, key);
    set({ recentCommands });
    try {
      localStorage.setItem(recentKey, JSON.stringify(recentCommands));
    } catch {
      // Keep navigation history usable for this session when storage is full.
    }
  },
  focusTarget: "",
  navigationKey: 0,
  sidebarCollapsed: readPreference("ark.sidebar-collapsed", false),
  openGroups: readPreference("ark.nav-groups", [0]),
  density:
    readPreference<string>("ark.density", "comfortable") === "compact"
      ? "compact"
      : "comfortable",
  setDensity: (density) => {
    localStorage.setItem("ark.density", JSON.stringify(density));
    set({ density });
  },
  toggleSidebar: () =>
    set((s) => {
      localStorage.setItem(
        "ark.sidebar-collapsed",
        JSON.stringify(!s.sidebarCollapsed),
      );
      return { sidebarCollapsed: !s.sidebarCollapsed };
    }),
  toggleGroup: (group) =>
    set((s) => {
      const openGroups = s.openGroups.includes(group)
        ? s.openGroups.filter((g) => g !== group)
        : [...s.openGroups, group];
      localStorage.setItem("ark.nav-groups", JSON.stringify(openGroups));
      return { openGroups };
    }),
  completeNavigation: () => {
    const next = get().pendingNavigation;
    set({ dirty: "", pendingNavigation: null });
    if (next?.instance) get().select(next.instance);
    if (next?.page) get().navigate(next.page, next.target);
    if (next?.commandKey) get().recordCommand(next.commandKey);
  },
  refresh: async () => {
    try {
      const data = await window.ark.call<Bootstrap>("bootstrap");
      set({
        data,
        error: "",
        selected: data.instances.some((i) => i.id === get().selected)
          ? get().selected
          : data.instances[0]?.id || "",
      });
    } catch (error) {
      set({ error: message(error) });
    }
  },
  select: (selected) => {
    if (selected === get().selected) return;
    if (get().dirty) {
      set({ pendingNavigation: { instance: selected } });
      return;
    }
    const positions = readPreference<Record<string, Page>>(
      "ark.instance-pages",
      {},
    );
    if (get().selected && !isGlobal(get().page))
      positions[get().selected] = get().page;
    localStorage.setItem("ark.instance-pages", JSON.stringify(positions));
    localStorage.setItem("ark.instance", selected);
    const saved = positions[selected];
    set({
      selected,
      page: isGlobal(get().page)
        ? get().page
        : navigation.some((n) => n.page === saved)
          ? saved
          : "overview",
      focusTarget: "",
    });
  },
  navigate: (page, target = "") => {
    if (get().dirty && page !== get().page) {
      set({ pendingNavigation: { page, target } });
      return;
    }
    if (!isGlobal(page) && get().selected) {
      const positions = readPreference<Record<string, Page>>(
        "ark.instance-pages",
        {},
      );
      positions[get().selected] = page;
      localStorage.setItem("ark.instance-pages", JSON.stringify(positions));
    }
    set({ page, focusTarget: target, navigationKey: get().navigationKey + 1 });
  },
  toast: (text, kind = "success") => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }].slice(-4) }));
    setTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      kind === "error" ? 9000 : 4500,
    );
  },
  mergeLogs: (id, lines) =>
    set((s) => ({
      logs: {
        ...s.logs,
        [id]: [
          ...new Map(
            [...(s.logs[id] || []), ...lines].map((l) => [l.seq, l]),
          ).values(),
        ]
          .sort((a, b) => a.seq - b.seq)
          .slice(-6000),
      },
    })),
  receive: (event) => {
    const state = get();
    if (event.type === "logs") {
      get().mergeLogs(event.instanceId!, event.data as LogLine[]);
      return;
    }
    if (!state.data) return;
    if (event.type === "snapshot") {
      const snapshot = event.data as Snapshot;
      set({
        data: {
          ...state.data,
          snapshots: [
            ...state.data.snapshots.filter((s) => s.id !== snapshot.id),
            snapshot,
          ],
        },
      });
    }
    if (event.type === "job") {
      const job = event.data as Job;
      set({
        data: {
          ...state.data,
          jobs: jobWindow([
            job,
            ...state.data.jobs.filter((j) => j.id !== job.id),
          ]),
        },
        revision: ["success", "failed"].includes(job.status)
          ? state.revision + 1
          : state.revision,
      });
      if (job.status === "failed")
        get().toast(`${job.title}：${job.detail}`, "error");
      if (job.status === "success") void get().refresh();
    }
    if (event.type === "activity")
      set({
        ...((event.data as { id?: string }).id === "disconnect"
          ? { error: "后台连接中断，下一次操作将尝试重新连接。" }
          : {}),
        data: {
          ...state.data,
          activities: [event.data as any, ...state.data.activities].slice(
            0,
            150,
          ),
        },
      });
    if (event.type === "settings")
      set({ data: { ...state.data, settings: event.data as any } });
  },
}));
export const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
export async function act<T = any>(
  method: string,
  args: Record<string, unknown> = {},
  success?: string,
): Promise<T | undefined> {
  try {
    const result = await window.ark.call<T>(method, args);
    if (success) useApp.getState().toast(success);
    if (!(result as any)?.status) await useApp.getState().refresh();
    return result;
  } catch (error) {
    useApp.getState().toast(message(error), "error");
  }
}
export const bytes = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value < 1024
      ? `${value} B`
      : value < 1024 ** 2
        ? `${(value / 1024).toFixed(1)} KB`
        : value < 1024 ** 3
          ? `${(value / 1024 ** 2).toFixed(1)} MB`
          : `${(value / 1024 ** 3).toFixed(2)} GB`;
export const date = (value: number | undefined) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export const time = (value: number) =>
  new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
export const duration = (seconds: number) =>
  seconds < 60
    ? `${Math.max(0, Math.floor(seconds))} 秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
        : `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时`;
export const statusLabel: Record<string, string> = {
  running: "运行中",
  stopped: "已停止",
  starting: "启动中",
  stopping: "保存关闭中",
  unmanaged: "外部进程",
  unknown: "识别中",
  queued: "等待执行",
  success: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
