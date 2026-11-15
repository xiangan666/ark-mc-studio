import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, ArkBridge } from "../shared/types";
import { version } from "../../package.json";
const bridge: ArkBridge = {
  call: (method, args = {}) => ipcRenderer.invoke("ark:call", method, args),
  onEvent: (listener) => {
    const handler = (_: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on("ark:event", handler);
    return () => ipcRenderer.removeListener("ark:event", handler);
  },
  chooseDirectory: () => ipcRenderer.invoke("ark:directory"),
  chooseFile: (filters) => ipcRenderer.invoke("ark:file", filters),
  saveFile: (name, content) => ipcRenderer.invoke("ark:save", name, content),
  reveal: (target) => ipcRenderer.invoke("ark:reveal", target),
  window: (action) => ipcRenderer.send("ark:window", action),
  setLogin: (enabled) => ipcRenderer.invoke("ark:login", enabled),
  reloadBackend: () => ipcRenderer.invoke("ark:backend-reload"),
  versions: {
    app: version,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
};
contextBridge.exposeInMainWorld("ark", bridge);
