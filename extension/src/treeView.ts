import * as vscode from "vscode";
import {
  accountRowDescription,
  accountRowLabel,
  accountStatusTooltipLines,
  deriveAccountStatus,
} from "./accountStatus";
import { AccountSummary, HealthInfo, PoolClient } from "./client";
import { countAccountsOnDisk, knownAlternateDataDirs } from "./addAccount";
import { readSettings } from "./settings";

export class PoolTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly accountId?: string,
    opts?: {
      description?: string;
      tooltip?: string;
      contextValue?: string;
      icon?: string;
      command?: vscode.Command;
    }
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = opts?.description;
    this.tooltip = opts?.tooltip;
    this.contextValue = opts?.contextValue;
    if (opts?.icon) this.iconPath = new vscode.ThemeIcon(opts.icon);
    if (opts?.command) this.command = opts.command;
  }
}

export class PoolTreeProvider implements vscode.TreeDataProvider<PoolTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<PoolTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private health: HealthInfo | undefined;
  private accounts: AccountSummary[] = [];
  private lastError: string | undefined;

  constructor(private readonly client: PoolClient) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  /** Compact pool status for TreeView.description (not a tree row). */
  getViewDescription(): string {
    if (!this.health) return "Stopped";
    return `${this.health.ready}/${this.health.accounts} ready`;
  }

  async reload(health: HealthInfo | undefined): Promise<void> {
    this.health = health;
    this.lastError = undefined;
    if (!this.health) {
      this.accounts = [];
      this.refresh();
      return;
    }
    try {
      this.accounts = await this.client.listAccounts();
    } catch (error) {
      this.accounts = [];
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.refresh();
  }

  getTreeItem(element: PoolTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): PoolTreeItem[] {
    const items: PoolTreeItem[] = [];
    const dataDir = readSettings().dataDir;

    // Pool aggregate status lives in TreeView.description — only keep an
    // actionable empty-state row when the pooler is down (no accounts to list).
    if (!this.health) {
      items.push(
        new PoolTreeItem("Pooler stopped", undefined, {
          icon: "debug-disconnect",
          contextValue: "poolStatus",
          tooltip: [
            "Click Start Pooler in the title bar, or run Zion Pool: Start Pooler",
            `DATA_DIR: ${dataDir}`,
          ].join("\n"),
          command: {
            command: "zionPool.start",
            title: "Start Pooler",
          },
        })
      );
    }

    if (this.lastError) {
      items.push(
        new PoolTreeItem(`Error: ${this.lastError}`, undefined, {
          icon: "error",
          contextValue: "poolError",
        })
      );
    }

    if (this.health && this.accounts.length === 0) {
      const onDisk = countAccountsOnDisk(dataDir);
      const alts = knownAlternateDataDirs(dataDir);
      const altHint =
        alts.length > 0
          ? `Found accounts in ${alts[0]} — set zionPool.dataDir or copy them into this DATA_DIR.`
          : undefined;
      items.push(
        new PoolTreeItem(`No accounts in ${dataDir}`, undefined, {
          icon: "warning",
          contextValue: "poolEmpty",
          tooltip: [
            `DATA_DIR: ${dataDir}`,
            onDisk === 0
              ? "No auth.json found under accounts/."
              : `${onDisk} account folder(s) on disk but pooler reports 0 — try refresh / restart.`,
            altHint,
            "Use Add account… to log in or import.",
          ]
            .filter(Boolean)
            .join("\n"),
          command: {
            command: "zionPool.addAccount",
            title: "Add account",
          },
        })
      );
    }

    for (const account of this.accounts) {
      const badge = deriveAccountStatus(account);
      items.push(
        new PoolTreeItem(accountRowLabel(account), account.id, {
          description: accountRowDescription(account, badge),
          tooltip: accountStatusTooltipLines(account, badge, dataDir).join("\n"),
          contextValue: "poolAccount",
          icon: badge.icon,
        })
      );
    }

    items.push(
      new PoolTreeItem("Add account…", undefined, {
        icon: "add",
        contextValue: "poolAction",
        command: {
          command: "zionPool.addAccount",
          title: "Add account",
        },
      })
    );

    return items;
  }
}
