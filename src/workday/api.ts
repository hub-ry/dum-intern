// The worker's contract with hub, shared by the in-VM worker (worker.ts) and hub's HTTP client
// (client.ts), so hub never loads the browser code.

export type ToolResult = { text: string; isError: boolean };

/** What hub gets back when the agent asks to submit: enough to ask Ryan, no secrets. */
export type PreparedSubmit = { nonce: string; fingerprint: string; url: string; title: string; summary: string; screenshotPng: string };

export interface WorkerApi {
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  prepareSubmit(): Promise<PreparedSubmit>;
  submit(token: string): Promise<ToolResult>;
}

/** A refusal or a mistake the caller can fix; its message is safe to show. */
export class WorkerError extends Error {}

/** The agent's browser tools, served by the worker. request_submit is hub's (mcp.ts). */
export const WORKER_TOOLS = ["open_application", "fill_from_profile", "upload_resume", "screenshot", "next_step"] as const;
