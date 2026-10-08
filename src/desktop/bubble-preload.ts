// The bubble's only bridge: it receives what to show and can send nothing back.
// Sandboxed and context-isolated; nothing from Node or Electron is handed to the page.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { BubbleAPI, BubbleView } from "./protocol.ts";

const api: BubbleAPI = {
  subscribe(listener: (view: BubbleView) => void): () => void {
    const forward = (_event: IpcRendererEvent, view: BubbleView) => listener(view);
    ipcRenderer.on("dum:bubble", forward);
    return () => {
      ipcRenderer.removeListener("dum:bubble", forward);
    };
  },
};

contextBridge.exposeInMainWorld("dumBubble", api);
