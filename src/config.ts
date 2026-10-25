export type Config = {
  mock: boolean;
  missing: string[];
  host: string;
  port: number;
  stateDir: string;
  paceMs: number;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  maritime: {
    baseUrl: string;
    apiKey: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const llmKey = env.LLM_API_KEY?.trim() ?? "";
  const maritimeKey = env.MARITIME_API_KEY?.trim() ?? "";
  const missing = [
    llmKey ? "" : "LLM_API_KEY",
    maritimeKey ? "" : "MARITIME_API_KEY",
  ].filter(Boolean);
  const port = Number(env.PORT ?? "8074");
  const pace = Number(env.DUM_PACE_MS ?? "380");
  return {
    mock: missing.length > 0,
    missing,
    host: env.HOST?.trim() || "127.0.0.1",
    port: Number.isFinite(port) && port >= 0 ? port : 8074,
    stateDir: env.DUM_STATE?.trim() || "./data",
    paceMs: Number.isFinite(pace) && pace >= 0 ? pace : 380,
    llm: {
      baseUrl: (env.LLM_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, ""),
      apiKey: llmKey,
      model: env.LLM_MODEL?.trim() || "deepseek-chat",
    },
    maritime: {
      baseUrl: (env.MARITIME_API_BASE?.trim() || "https://api.maritime.sh").replace(/\/$/, ""),
      apiKey: maritimeKey,
    },
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
