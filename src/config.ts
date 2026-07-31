import os from "node:os";
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  quotaSkipThreshold: number;
  quotaPollMs: number;
  upstreamBase: string;
}

export function loadConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 4000,
    dataDir: path.join(os.homedir(), ".zion-codex-pool"),
    quotaSkipThreshold: 95,
    quotaPollMs: 120_000,
    upstreamBase: "https://chatgpt.com/backend-api/codex",
  };
}
