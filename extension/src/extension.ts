import * as vscode from "vscode";
import { accountDisplayName } from "./accountStatus";
import { runAddAccount } from "./addAccount";
import { PoolClient } from "./client";
import { applyCodexConfig, codexConfigPath } from "./codexConfig";
import { PoolProcessManager } from "./process";
import { readSettings } from "./settings";
import { PoolStatusBar } from "./statusBar";
import { PoolTreeProvider } from "./treeView";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const client = new PoolClient();
  const processManager = new PoolProcessManager(context.extensionPath, client);
  const tree = new PoolTreeProvider(client);
  const statusBar = new PoolStatusBar(client);

  const treeView = vscode.window.createTreeView("zionPool.accounts", {
    treeDataProvider: tree,
    showCollapseAll: false,
  });

  const checkHealth = async () => {
    const health = await client.health();
    await vscode.commands.executeCommand("setContext", "zionPool.running", Boolean(health));
    return health;
  };

  const refreshUi = async (): Promise<void> => {
    const health = await checkHealth();
    await Promise.all([tree.reload(health), statusBar.reload(health)]);
    treeView.description = tree.getViewDescription();
  };

  const ensurePool = async (): Promise<boolean> => {
    const settings = readSettings();
    const ok = await processManager.ensureRunning(settings);
    if (ok && settings.applyConfigOnStart) {
      try {
        applyCodexConfig(settings);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        processManager.outputChannel.appendLine(`applyCodexConfig failed: ${msg}`);
      }
    }
    await refreshUi();
    return ok;
  };

  const addAccount = async (): Promise<void> => {
    await runAddAccount({
      client,
      settings: readSettings(),
      ensurePool,
      refreshUi,
      log: (line) => processManager.outputChannel.appendLine(line),
    });
  };

  context.subscriptions.push(
    treeView,
    processManager,
    statusBar,
    vscode.commands.registerCommand("zionPool.start", async () => {
      const ok = await ensurePool();
      if (ok) {
        void vscode.window.showInformationMessage("Zion Pool: pooler is running.");
      }
    }),
    vscode.commands.registerCommand("zionPool.stop", async () => {
      await processManager.stop();
      // If something else owns the port, health may still succeed — that's fine.
      await refreshUi();
      void vscode.window.showInformationMessage("Zion Pool: stop signal sent.");
    }),
    vscode.commands.registerCommand("zionPool.refresh", async () => {
      await refreshUi();
    }),
    vscode.commands.registerCommand("zionPool.refreshQuota", async () => {
      if (!(await checkHealth())) {
        const started = await ensurePool();
        if (!started) return;
      }
      try {
        const n = await client.refreshQuota();
        await refreshUi();
        void vscode.window.showInformationMessage(`Zion Pool: refreshed quota for ${n} account(s).`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Zion Pool: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("zionPool.addAccount", () => addAccount()),
    // Kept for Command Palette / backwards compat; title-bar icons removed.
    vscode.commands.registerCommand("zionPool.importLive", () => addAccount()),
    vscode.commands.registerCommand("zionPool.importFile", () => addAccount()),
    vscode.commands.registerCommand("zionPool.deleteAccount", async (item?: { accountId?: string }) => {
      if (!(await checkHealth())) {
        void vscode.window.showWarningMessage("Zion Pool: pooler is not running.");
        return;
      }
      let id = item?.accountId;
      if (!id) {
        const accounts = await client.listAccounts();
        const pick = await vscode.window.showQuickPick(
          accounts.map((a) => ({
            label: accountDisplayName(a),
            description: a.id,
            id: a.id,
          })),
          { placeHolder: "Account to delete" }
        );
        id = pick?.id;
      }
      if (!id) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete pool account ${id}?`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") return;
      try {
        await client.deleteAccount(id);
        await refreshUi();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Zion Pool: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("zionPool.applyCodexConfig", async () => {
      try {
        const result = applyCodexConfig(readSettings());
        const note = result.changed
          ? result.created
            ? `Created ${result.path}`
            : `Updated ${result.path}`
          : `${result.path} already wired`;
        void vscode.window.showInformationMessage(
          `Zion Pool: ${note}. Restart Codex extension host if the IDE still points elsewhere.`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Zion Pool: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("zionPool.openOutput", () => {
      processManager.outputChannel.show(true);
    }),
    vscode.commands.registerCommand("zionPool.openDataDir", async () => {
      const dir = readSettings().dataDir;
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("zionPool")) {
        void refreshUi();
      }
    })
  );

  const minutes = Math.max(1, readSettings().quotaRefreshMinutes);
  const timer = setInterval(() => {
    void refreshUi();
  }, minutes * 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  if (readSettings().autoStart) {
    await ensurePool();
  } else {
    await refreshUi();
  }

  void vscode.window.setStatusBarMessage(
    `Zion Pool ready · config ${codexConfigPath()}`,
    4000
  );
}

export function deactivate(): void {
  // Process manager dispose is registered on context.subscriptions.
}
