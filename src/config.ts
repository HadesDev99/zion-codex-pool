import os from "node:os";
import path from "node:path";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

export interface Config {
  host: string;
  port: number;
  poolApiKey: string;
  dataDir: string;
  quotaSkipThreshold: number;
  quotaPollMs: number;
  upstreamBase: string;
}

export function loadConfig(): Config {
  const dataDir = envStr("DATA_DIR", path.join(os.homedir(), ".zion-codex-pool"));
  return {
    host: envStr("HOST", "127.0.0.1"),
    port: envInt("PORT", 4000),
    poolApiKey: envStr("POOL_API_KEY", "change-me"),
    dataDir,
    quotaSkipThreshold: Math.min(100, Math.max(50, envInt("QUOTA_SKIP_THRESHOLD", 95))),
    quotaPollMs: Math.max(30_000, envInt("QUOTA_POLL_MS", 120_000)),
    upstreamBase: envStr("UPSTREAM_BASE", "https://chatgpt.com/backend-api/codex").replace(/\/$/, ""),
  };
}
