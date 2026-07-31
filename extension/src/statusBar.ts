import * as vscode from "vscode";
import { AccountSummary, HealthInfo, PoolClient } from "./client";
import { readSettings } from "./settings";

export class PoolStatusBar {
  private readonly item: vscode.StatusBarItem;
  private health: HealthInfo | undefined;
  private accounts: AccountSummary[] = [];

  constructor(private readonly client: PoolClient) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
    this.item.command = "zionPool.refresh";
  }

  dispose(): void {
    this.item.dispose();
  }

  async reload(health: HealthInfo | undefined): Promise<void> {
    this.health = health;
    if (this.health) {
      try {
        this.accounts = await this.client.listAccounts();
      } catch {
        this.accounts = [];
      }
    } else {
      this.accounts = [];
    }
    this.refresh();
  }

  refresh(): void {
    if (!readSettings().statusBarEnabled) {
      this.item.hide();
      return;
    }

    const dataDir = readSettings().dataDir;

    if (!this.health) {
      this.item.text = "$(debug-disconnect) Pool: off";
      this.item.tooltip = [
        "Zion Codex Pool is not running. Click to refresh / start via command palette.",
        `DATA_DIR: ${dataDir}`,
      ].join("\n");
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.command = "zionPool.start";
      this.item.show();
      return;
    }

    const best = this.accounts
      .map((a) => (typeof a.quotaUsed === "number" ? a.quotaUsed : 100))
      .sort((a, b) => a - b)[0];
    const badge = typeof best === "number" ? `${Math.round(best)}%` : "?%";

    this.item.text = `$(server-process) Pool ${this.health.ready}/${this.health.accounts} · ${badge}`;
    this.item.tooltip = [
      "Zion Codex Pool",
      `${this.health.ready}/${this.health.accounts} accounts ready`,
      `Lowest quota used: ${badge}`,
      `DATA_DIR: ${dataDir}`,
      "Click to refresh",
    ].join("\n");
    this.item.backgroundColor = undefined;
    this.item.command = "zionPool.refresh";
    this.item.show();
  }
}
