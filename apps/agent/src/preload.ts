import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("anytimeVibe", {
  getState: () => ipcRenderer.invoke("agent:get-state"),
  setRelayUrl: (relayUrl: string) => ipcRenderer.invoke("agent:set-relay-url", relayUrl),
  setDisplayName: (displayName: string) => ipcRenderer.invoke("agent:set-display-name", displayName),
  startPairing: () => ipcRenderer.invoke("agent:start-pairing"),
  addWorkspace: () => ipcRenderer.invoke("agent:add-workspace"),
  removeWorkspace: (id: string) => ipcRenderer.invoke("agent:remove-workspace", id),
  reconnect: () => ipcRenderer.invoke("agent:reconnect"),
  checkEnvironment: () => ipcRenderer.invoke("agent:check-environment"),
  installEnvironment: (target: "node" | "codex") => ipcRenderer.invoke("agent:install-environment", target),
  checkUpdate: () => ipcRenderer.invoke("agent:check-update"),
  installUpdate: () => ipcRenderer.invoke("agent:install-update"),
  relayTask: (threadId: string) => ipcRenderer.invoke("agent:relay-task", threadId),
  refreshTasks: () => ipcRenderer.invoke("agent:refresh-tasks"),
  setCliEngine: (engine: string) => ipcRenderer.invoke("agent:set-cli-engine", engine),
  refreshEngines: () => ipcRenderer.invoke("agent:refresh-engines"),
  windowMinimize: () => ipcRenderer.invoke("agent:window-minimize"),
  windowClose: () => ipcRenderer.invoke("agent:window-close"),
  openFeedback: () => ipcRenderer.invoke("agent:open-feedback"),
  onState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("agent:state", wrapped);
    return () => ipcRenderer.removeListener("agent:state", wrapped);
  }
});
