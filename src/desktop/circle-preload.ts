// The circle's only bridge: its own restricted "dum:circle" channel. It can send gestures, the
// accessibility toggle and a read of its small view; it receives that view and nothing else.
// Sandboxed and context-isolated; nothing from Node or Electron is handed to the page.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { CircleAPI, CircleReply, CircleRequest, CircleView } from "./protocol.ts";

const api: CircleAPI = {
  invoke: (request: CircleRequest): Promise<CircleReply> => ipcRenderer.invoke("dum:circle", request),
  subscribe(listener: (view: CircleView) => void): () => void {
    const forward = (_event: IpcRendererEvent, view: CircleView) => listener(view);
    ipcRenderer.on("dum:circle", forward);
    return () => {
      ipcRenderer.removeListener("dum:circle", forward);
    };
  },
};

contextBridge.exposeInMainWorld("dumCircle", api);
