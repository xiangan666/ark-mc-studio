import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  Notification,
} from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { AgentClient } from "./agent-client";
import { DirectRoutes } from "./direct-routes";
import { NetworkControl } from "./network-control";
import { resolveTunnelClient } from "../agent/tunnel-clients";
import { tunnelClients, type TunnelProvider } from "../shared/network";
import { upgradeWorkspace } from "./workspace-upgrade";
import type { WorkspaceUpgradeReport } from "../shared/workspace-upgrade";
import { networkControlMethods } from "../shared/network-control";
import { ProgramLifecycle } from "./program-lifecycle";
import type { AgentEvent, Bootstrap, Settings } from "../shared/types";

const dataRoot =
  process.env.ARK_MC_DATA || path.join(app.getPath("appData"), "ArkMC Studio");
app.setPath("userData", path.join(dataRoot, "desktop"));
const single = app.requestSingleInstanceLock();
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let settings: Settings | undefined;
let agent: AgentClient;
let directRoutes: DirectRoutes;
let networkControl: NetworkControl;
let upgradeReport: WorkspaceUpgradeReport | null = null;
let upgrading: Promise<WorkspaceUpgradeReport> | undefined;
let programLifecycle: ProgramLifecycle;
let requestProgramExit: (() => Promise<void>) | undefined;
if (!single) app.quit();
function show() {
  if (!window) return;
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
}
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (
    event.sender !== window?.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("非法的窗口请求");
}
function resources() {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), "resources");
}
async function backendResources() {
  if (!app.isPackaged) return resources();
  const fingerprint = createHash("sha256")
    .update(await fs.readFile(path.join(resources(), "agent", "agent.cjs")))
    .digest("hex")
    .slice(0, 16);
  const portableBase =
    process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
  const workspace = existsSync(path.join(portableBase, "..", "启动方舟MC.cmd"))
    ? path.resolve(portableBase, "..")
    : portableBase;
  const base = path.join(
    process.env.ARK_MC_TOOLS || path.join(workspace, "managed-tools"),
    "desktop-host",
  );
  const destination = path.join(base, `${app.getVersion()}-${fingerprint}`);
  if (existsSync(path.join(destination, ".ready"))) return destination;
  const stage = path.join(base, `.install-${randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });
  try {
    for (const entry of [
      "agent",
      "direct",
      "network",
      "server",
      "runtime",
      "probes",
      "signal-router",
      "telemetry.ps1",
      "dpapi.ps1",
    ])
      await fs.cp(path.join(resources(), entry), path.join(stage, entry), {
        recursive: true,
      });
    await fs.writeFile(path.join(stage, ".ready"), "1");
    await fs.rename(stage, destination);
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  return destination;
}
async function init() {
  await fs.mkdir(dataRoot, { recursive: true });
  if (
    process.platform === "win32" &&
    !existsSync(path.join(dataRoot, ".acl-ready"))
  ) {
    await new Promise<void>((resolve) =>
      execFile(
        "icacls.exe",
        [
          dataRoot,
          "/inheritance:r",
          "/grant:r",
          `${os.userInfo().username}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
        ],
        { windowsHide: true },
        async (error) => {
          if (!error)
            await fs.writeFile(path.join(dataRoot, ".acl-ready"), "1");
          resolve();
        },
      ),
    );
  }
  const backend = await backendResources();
  const node = app.isPackaged
    ? path.join(backend, "runtime", "node.exe")
    : existsSync(path.join(resources(), "runtime", "node.exe"))
      ? path.join(resources(), "runtime", "node.exe")
      : "node.exe";
  const agentFile = app.isPackaged
    ? path.join(backend, "agent", "agent.cjs")
    : path.join(app.getAppPath(), "dist-agent", "agent.cjs");
  const portableBase =
    process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
  const workspace = app.isPackaged
    ? existsSync(path.join(portableBase, "..", "启动方舟MC.cmd"))
      ? path.resolve(portableBase, "..")
      : portableBase
    : app.getAppPath();
  const toolsRoot =
    process.env.ARK_MC_TOOLS || path.join(workspace, "managed-tools");
  agent = new AgentClient(dataRoot, agentFile, node, backend, toolsRoot);
  await agent.connect();
  networkControl = new NetworkControl(
    agent,
    dataRoot,
    toolsRoot,
    node,
    app.isPackaged
      ? path.join(backend, "network", "worker.cjs")
      : path.join(app.getAppPath(), "dist-network", "worker.cjs"),
    backend,
    (event) => window?.webContents.send("ark:event", event),
  );
  const checkWorkspace = () => {
    if (upgrading) return upgrading;
    upgrading = agent
      .call<Bootstrap>("bootstrap")
      .then((state) =>
        upgradeWorkspace({
          toolsRoot,
          currentResources: backend,
          version: app.getVersion(),
          state,
        }),
      )
      .then((report) => {
        upgradeReport = report;
        return report;
      })
      .finally(() => {
        upgrading = undefined;
      });
    return upgrading;
  };
  directRoutes = new DirectRoutes(
    agent,
    toolsRoot,
    node,
    app.isPackaged
      ? path.join(backend, "direct", "host.cjs")
      : path.join(app.getAppPath(), "dist-direct", "host.cjs"),
    path.join(backend, "probes", "route-check.exe"),
  );
  programLifecycle = new ProgramLifecycle(
    agent,
    directRoutes,
    networkControl,
    dataRoot,
    app.getVersion(),
    checkWorkspace,
  );
  await programLifecycle.init();
  const initialState = await agent.call<Bootstrap>("bootstrap");
  if (
    programLifecycle.acceptsService(initialState.agentVersion) &&
    programLifecycle.status.phase !== "failed"
  ) {
    if (initialState.agentVersion === app.getVersion())
      void directRoutes
        .restore()
        .catch((error) => console.warn("IPv6 direct restore:", error.message));
    void checkWorkspace().catch((error) => {
      upgradeReport = {
        version: app.getVersion(),
        checkedAt: Date.now(),
        status: "attention",
        changes: [],
        retained: [],
        warnings: ["自动整理暂未完成：" + error.message],
        removedBytes: 0,
      };
    });
  }
  try {
    settings = (await agent.call<Bootstrap>("bootstrap")).settings;
  } catch {}
  const icon = path.join(resources(), "icon.png");
  requestProgramExit = async () => {
    if (programLifecycle.busy) {
      await dialog.showMessageBox({
        type: "info",
        message: "程序正在更新或退出，请等待完成。",
      });
      return;
    }
    try {
      const state = await agent.call<Bootstrap>("bootstrap");
      if (state.snapshots.some((s) => s.pid)) {
        const answer = await dialog.showMessageBox({
          type: "question",
          buttons: ["取消", "正常关服并彻底退出"],
          defaultId: 0,
          cancelId: 0,
          message: "退出程序并关闭后台？",
          detail:
            "将正常保存并关闭服务器，断开在线玩家，停止本程序管理的穿透、信令与 IPv6 服务，最后关闭界面和后台。",
        });
        if (answer.response !== 1) return;
      }
      await programLifecycle.quit();
      quitting = true;
      app.quit();
    } catch (error: any) {
      show();
      await dialog.showMessageBox({
        type: "error",
        message: "程序尚未彻底退出",
        detail: error.message,
      });
    }
  };
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: "#0a1015",
    title: "方舟 MC · ArkMC Studio",
    icon,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("context-menu", (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ]
      : [
          {
            role: "copy",
            label: "复制所选内容",
            enabled: !!params.selectionText,
          },
          { role: "selectAll", label: "全选" },
        ];
    items.push(
      { type: "separator" },
      { label: "刷新管理界面", click: () => window?.webContents.reload() },
    );
    Menu.buildFromTemplate(items).popup({ window });
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window?.webContents.getURL();
    if (current && url !== current) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!quitting && settings?.closeToTray !== false) {
      event.preventDefault();
      window!.hide();
    } else if (!quitting) {
      event.preventDefault();
      void requestProgramExit?.();
    }
  });
  window.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) window!.show();
  });
  const trayIcon = nativeImage
    .createFromPath(icon)
    .resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon);
  tray.setToolTip("方舟 MC · ArkMC Studio");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开方舟控制台", click: show },
      { type: "separator" },
      {
        label: "退出程序（同时关闭后台）",
        click: () => void requestProgramExit?.(),
      },
    ]),
  );
  tray.on("double-click", show);
  agent.on("event", (event: AgentEvent) => {
    window?.webContents.send("ark:event", event);
    if (event.type === "settings") settings = event.data as Settings;
    if (event.type === "job" && settings?.notifications) {
      const job = event.data as any;
      if (
        ["success", "failed"].includes(job.status) &&
        !window?.isFocused() &&
        Notification.isSupported()
      )
        new Notification({
          title: job.status === "success" ? "任务已完成" : "任务需要处理",
          body: `${job.title}：${job.detail}`,
          icon,
        }).show();
    }
  });
  agent.on("disconnected", () => {
    window?.webContents.send("ark:event", {
      type: "activity",
      data: {
        id: "disconnect",
        at: Date.now(),
        level: "error",
        text: "后台连接中断，下一次操作将尝试重新连接。",
      },
    });
  });
  ipcMain.handle("ark:call", async (event, method, args) => {
    trusted(event);
    if (
      typeof method !== "string" ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      throw new Error("无效的请求");
    try {
      if (method === "bootstrap") {
        const data = await agent.call<Bootstrap>(method, args);
        return {
          ...data,
          programUpdating:
            !programLifecycle.acceptsService(data.agentVersion) ||
            (programLifecycle.status.mode === "upgrade" &&
              ["running", "failed"].includes(programLifecycle.status.phase)),
        };
      }
      if (method === "program.upgrade.get") return programLifecycle.status;
      if (method === "program.upgrade.run")
        return programLifecycle.startUpgrade();
      if (method === "program.upgrade.exit") {
        if (programLifecycle.busy) throw new Error("更新正在进行，请等待完成");
        quitting = true;
        setTimeout(() => app.quit(), 50);
        return true;
      }
      const current = await agent.call<Bootstrap>("bootstrap");
      if (programLifecycle.busy)
        throw new Error("程序正在更新或退出，请等待完成");
      if (!programLifecycle.acceptsService(current.agentVersion))
        throw new Error("检测到旧版服务，请先确认保留运行并更新程序");
      if (method === "workspace.upgrade.get")
        return { running: !!upgrading, report: upgradeReport };
      if (method === "workspace.upgrade.run") return await checkWorkspace();
      if (networkControlMethods.has(method) && method !== "tunnels.get")
        return await networkControl.call(method, args);
      if (method === "jobs.cancel" && networkControl.cancel(args?.id))
        return true;
      if (
        args?.id &&
        networkControl.busy(args.id) &&
        /^(server\.action|tunnels\.(import|target|attach|prepare)|backups\.restore|core-updates\.apply)$/.test(
          method,
        )
      )
        throw new Error("该实例网络操作正在执行，请等待完成");
      if (method === "tunnels.get") {
        const data = (await networkControl.call(method, args)) as any;
        const providers = [
          ...new Set<TunnelProvider>(
            data.tunnels.map((t: any) => t.provider || "lolia"),
          ),
        ];
        data.clients = await Promise.all(
          providers
            .filter((p) => Object.hasOwn(tunnelClients, p))
            .map((p) => resolveTunnelClient(toolsRoot, p)),
        );
        for (const route of data.routes) {
          const router = data.routers?.find(
            (r: any) => r.signalId === route.signalId && r.enabled,
          );
          route.routerHealthy = router?.healthy;
          route.routerRunning = router?.running;
          const tunnel = data.tunnels.find((t: any) => t.id === route.signalId);
          const client = data.clients.find(
            (c: any) => c.provider === (tunnel?.provider || "lolia"),
          );
          route.clientReady = client?.ready;
          route.clientError = client?.ready ? undefined : client?.detail;
        }
        return data;
      }
      if (method.startsWith("direct.")) {
        if (!args || typeof args.id !== "string")
          throw new Error("缺少实例编号");
        if (method === "direct.get") return await directRoutes.get(args.id);
        if (method === "direct.action")
          return await directRoutes.action(args.id, args.action);
        if (method === "direct.diagnose")
          return await directRoutes.diagnose(args.id, args.advanced === true);
        throw new Error("不支持的直连操作");
      }
      return await agent.call(method, args);
    } catch (error: any) {
      throw new Error(error.message);
    }
  });
  ipcMain.handle("ark:backend-reload", async (event) => {
    trusted(event);
    if (programLifecycle.busy)
      throw new Error("程序正在更新或退出，请等待完成");
    const current = await agent.call<Bootstrap>("bootstrap");
    if (current.agentVersion !== app.getVersion())
      throw new Error("请先确认程序更新；旧式会话需手动完成首次切换");
    return agent.reloadPreservingSessions();
  });
  ipcMain.handle("ark:directory", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("ark:file", async (event, filters) => {
    trusted(event);
    const safeFilters = Array.isArray(filters)
      ? filters.filter(
          (f) =>
            typeof f.name === "string" &&
            Array.isArray(f.extensions) &&
            f.extensions.every(
              (x: unknown) => typeof x === "string" && /^[a-z0-9*]+$/i.test(x),
            ),
        )
      : [];
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openFile"],
      filters: safeFilters,
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("ark:save", async (event, name, content) => {
    trusted(event);
    if (
      typeof name !== "string" ||
      typeof content !== "string" ||
      Buffer.byteLength(content) > 16 * 1024 * 1024
    )
      throw new Error("导出内容过大");
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: path.basename(name),
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, content, "utf8");
    return result.filePath;
  });
  ipcMain.handle("ark:reveal", async (event, target) => {
    trusted(event);
    if (typeof target !== "string" || !path.isAbsolute(target))
      throw new Error("无效的文件路径");
    await fs.stat(target);
    shell.showItemInFolder(target);
  });
  ipcMain.handle("ark:login", async (event, enabled) => {
    trusted(event);
    if (typeof enabled !== "boolean") throw new Error("无效的设置");
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      args: ["--hidden"],
    });
    return true;
  });
  ipcMain.on("ark:window", (event, action) => {
    trusted(event);
    if (action === "minimize") window!.minimize();
    else if (action === "maximize")
      window!.isMaximized() ? window!.unmaximize() : window!.maximize();
    else if (action === "close") window!.close();
  });
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged)
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(__dirname, "../renderer/index.html"));
}
app.on("second-instance", show);
app.on("activate", show);
app.on("before-quit", (event) => {
  if (!quitting && requestProgramExit) {
    event.preventDefault();
    void requestProgramExit();
  } else quitting = true;
});
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});
if (single)
  app
    .whenReady()
    .then(init)
    .catch(async (error) => {
      await dialog.showMessageBox({
        type: "error",
        title: "ArkMC Studio",
        message: "启动失败",
        detail: String(error),
      });
      quitting = true;
      app.quit();
    });
