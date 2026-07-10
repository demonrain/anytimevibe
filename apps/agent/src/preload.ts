import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("anytimeVibe", {
  getState: () => ipcRenderer.invoke("agent:get-state"),
  setRelayUrl: (relayUrl: string) => ipcRenderer.invoke("agent:set-relay-url", relayUrl),
  startPairing: () => ipcRenderer.invoke("agent:start-pairing"),
  addWorkspace: () => ipcRenderer.invoke("agent:add-workspace"),
  removeWorkspace: (id: string) => ipcRenderer.invoke("agent:remove-workspace", id),
  reconnect: () => ipcRenderer.invoke("agent:reconnect"),
  onState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("agent:state", wrapped);
    return () => ipcRenderer.removeListener("agent:state", wrapped);
  }
});
