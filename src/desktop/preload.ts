// The renderer's only bridge: one validated request channel and snapshot notifications.
// Sandboxed and context-isolated; nothing from Node or Electron is handed to the page.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopAPI, Request, Reply, Snapshot } from "./protocol.ts";

const api: DesktopAPI = {
  invoke: (request: Request): Promise<Reply> => ipcRenderer.invoke("dum:request", request),
  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    const forward = (_event: IpcRendererEvent, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on("dum:snapshot", forward);
    return () => {
      ipcRenderer.removeListener("dum:snapshot", forward);
    };
  },
};

contextBridge.exposeInMainWorld("dum", api);
