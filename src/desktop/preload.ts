// The working window's only bridge: one validated request channel and snapshot notifications. The
// circle has its own restricted `dum:circle` bridge and the bubble a receive-only one; main also
// checks each sender's role, so this channel answers only the working window.
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
