import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";

export interface PoolSettings {
  autoStart: boolean;
  host: string;
  port: number;
  dataDir: string;
  serverPath: string;
  quotaRefreshMinutes: number;
  statusBarEnabled: boolean;
  applyConfigOnStart: boolean;
}

export function readSettings(): PoolSettings {
  const cfg = vscode.workspace.getConfiguration("zionPool");
  return {
    autoStart: cfg.get<boolean>("autoStart", true),
    host: "127.0.0.1",
    port: 4000,
    dataDir: path.join(os.homedir(), ".zion-codex-pool"),
    serverPath: (cfg.get<string>("serverPath") ?? "").trim(),
    quotaRefreshMinutes: cfg.get<number>("quotaRefreshMinutes", 2),
    statusBarEnabled: cfg.get<boolean>("statusBar.enabled", true),
    applyConfigOnStart: cfg.get<boolean>("applyConfigOnStart", true),
  };
}

export function baseUrl(settings = readSettings()): string {
  return `http://${settings.host}:${settings.port}`;
}
