import type { State } from "../store.ts";
import type { Mode } from "../gate.ts";
import type { View as TreeView } from "../web/view.ts";
import type { DictationStatus } from "./dictation.ts";

/** Renderer has no Node access. Only this finite, validated request surface crosses IPC. */
export type Settings = {
  hotkey: string;
  alwaysOnTop: boolean;
  allWorkspaces: boolean;
  launchAtLogin: boolean;
  personalContext: boolean;
  wizardAdvice: boolean;
  wizardSource: 'screen' | 'files';
};
export type RuntimeStatus = { available: boolean; authenticated: boolean; loginRunning: boolean; loginNeedsCode: boolean; gitAvailable: boolean; message: string };
export type Snapshot = {
  state: State | null;
  inputToken: string;
  tree: TreeView | null;
  canAttach: boolean;
  recentProjects: { name: string; root: string }[];
  settings: Settings;
  wizardStatus: string;
  hotkeyError: string;
  runtime: RuntimeStatus;
  screenPermission: string;
  dictation: DictationStatus;
  platform: string;
  version: string;
};
export type CaptureSource = { id: string; name: string; kind: "screen" | "window" };
export type CapturePreview = { token: string; name: string; dataUrl: string; expiresAt: number };
export type Panel = "tree" | "memory" | "history" | "context" | "evidence" | "boundary";
export type Request =
  | { type: "snapshot" }
  | { type: "choose-project" }
  | { type: "open-project"; root: string }
  | { type: "send"; text: string; inputToken: string; captureToken?: string }
  | { type: "interrupt" }
  | { type: "panel"; panel: Panel }
  | { type: "command"; name: "inspect" | "changes" | "practice" | "submit" | "run" | "remember"; argument: string }
  | { type: "open-record"; record: "proposal" | "course" | "memory"; path?: string }
  | { type: "mode"; mode: Mode }
  | { type: "settings"; settings: Settings }
  | { type: "capture-sources" }
  | { type: "git-setup" }
  | { type: "capture-preview"; sourceId: string; inputToken: string }
  | { type: "capture-discard" }
  | { type: "screen-permission" }
  | { type: "dictation-open" }
  | { type: "runtime-check" }
  | { type: "runtime-login" }
  | { type: "runtime-login-open" }
  | { type: "runtime-login-code"; code: string }
  | { type: "runtime-login-cancel" }
  | { type: "toggle-panel" }
  | { type: "hide-panel" }
  | { type: "move-companion"; dx: number; dy: number }
  | { type: "quit" };
export type Reply = { ok: true; snapshot?: Snapshot; sources?: CaptureSource[]; preview?: CapturePreview } | { ok: false; error: string };
export type DesktopAPI = {
  invoke(request: Request): Promise<Reply>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
};
