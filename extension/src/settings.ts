import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";

export interface PoolSettings {
  autoStart: boolean;
  host: string;
  port: number;
  dataDir: string;
  poolApiKey: string;
  serverPath: string;
  quotaRefreshMinutes: number;
  statusBarEnabled: boolean;
  applyConfigOnStart: boolean;
}

export function readSettings(): PoolSettings {
  const cfg = vscode.workspace.getConfiguration("zionPool");
  const dataDir = (cfg.get<string>("dataDir") ?? "").trim();
  return {
    autoStart: cfg.get<boolean>("autoStart", true),
    host: (cfg.get<string>("host") ?? "127.0.0.1").trim() || "127.0.0.1",
    port: cfg.get<number>("port", 4000),
    dataDir: dataDir || path.join(os.homedir(), ".zion-codex-pool"),
    poolApiKey: (cfg.get<string>("poolApiKey") ?? "").trim(),
    serverPath: (cfg.get<string>("serverPath") ?? "").trim(),
    quotaRefreshMinutes: cfg.get<number>("quotaRefreshMinutes", 2),
    statusBarEnabled: cfg.get<boolean>("statusBar.enabled", true),
    applyConfigOnStart: cfg.get<boolean>("applyConfigOnStart", true),
  };
}

export function baseUrl(settings = readSettings()): string {
  return `http://${settings.host}:${settings.port}`;
}
