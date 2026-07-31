import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { PoolClient } from "./client";
import { liveCodexAuthPath, readJsonFile } from "./importAuth";
import { PoolSettings } from "./settings";

type AddChoice = "login" | "importLive" | "importFile";

/**
 * Single "Add account" entry: QuickPick that folds login + Pool-native import paths.
 */
export async function runAddAccount(opts: {
  client: PoolClient;
  settings: PoolSettings;
  ensurePool: () => Promise<boolean>;
  refreshUi: () => Promise<void>;
  log: (line: string) => void;
}): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(key) Log in with Codex (new account)",
        description: "Opens a terminal · codex login in an isolated profile",
        id: "login" as AddChoice,
      },
      {
        label: "$(cloud-download) Import live ~/.codex/auth.json",
        description: liveCodexAuthPath(),
        id: "importLive" as AddChoice,
      },
      {
        label: "$(file-add) Import auth.json file…",
        description: "Pick a Codex auth.json from disk",
        id: "importFile" as AddChoice,
      },
    ],
    {
      title: "Zion Pool: Add account",
      placeHolder: "How do you want to add an account?",
      ignoreFocusOut: true,
    }
  );
  if (!pick) return;

  if (!(await opts.ensurePool())) return;

  switch (pick.id) {
    case "login":
      await loginWithCodex(opts);
      break;
    case "importLive":
      await importLive(opts);
      break;
    case "importFile":
      await importFile(opts);
      break;
  }
}

async function importLive(opts: {
  client: PoolClient;
  refreshUi: () => Promise<void>;
}): Promise<void> {
  const file = liveCodexAuthPath();
  if (!fs.existsSync(file)) {
    void vscode.window.showErrorMessage(`No live auth at ${file}`);
    return;
  }
  try {
    const result = await opts.client.importAuth(readJsonFile(file), "live");
    await opts.refreshUi();
    void vscode.window.showInformationMessage(
      `Zion Pool: imported ${result.email ?? result.id}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Zion Pool: ${msg}`);
  }
}

async function importFile(opts: {
  client: PoolClient;
  refreshUi: () => Promise<void>;
}): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { JSON: ["json"] },
    openLabel: "Import auth.json",
  });
  if (!picked?.[0]) return;
  try {
    const auth = readJsonFile(picked[0].fsPath);
    const result = await opts.client.importAuth(auth);
    await opts.refreshUi();
    void vscode.window.showInformationMessage(
      `Zion Pool: imported ${result.email ?? result.id}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Zion Pool: ${msg}`);
  }
}

async function loginWithCodex(opts: {
  client: PoolClient;
  settings: PoolSettings;
  refreshUi: () => Promise<void>;
  log: (line: string) => void;
}): Promise<void> {
  const pendingId = `login_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const codexHome = path.join(opts.settings.dataDir, "login-pending", pendingId);
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const authPath = path.join(codexHome, "auth.json");

  const terminal = vscode.window.createTerminal({
    name: "Codex login (Zion Pool)",
    cwd: codexHome,
    env: { CODEX_HOME: codexHome },
  });
  terminal.show();
  terminal.sendText("codex login");

  void vscode.window.showInformationMessage(
    "Zion Pool: finish `codex login` in the terminal. The account will appear once auth.json is written."
  );

  const imported = await waitForAuthAndImport(authPath, opts.client, opts.log, 10 * 60_000);
  if (imported) {
    await opts.refreshUi();
    void vscode.window.showInformationMessage(
      `Zion Pool: added ${imported.email ?? imported.id}`
    );
  } else {
    void vscode.window.showWarningMessage(
      "Zion Pool: login timed out or was cancelled. You can retry via Add account."
    );
  }

  // Best-effort cleanup of the isolated login home (auth already imported).
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function waitForAuthAndImport(
  authPath: string,
  client: PoolClient,
  log: (line: string) => void,
  timeoutMs: number
): Promise<{ id: string; email?: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(authPath)) {
      try {
        // Give Codex a moment to finish writing.
        await sleep(400);
        const auth = readJsonFile(authPath);
        return await client.importAuth(auth);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`login import failed (will retry): ${msg}`);
      }
    }
    await sleep(1000);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Alternate data dirs that often hold accounts from CLI/manual runs. */
export function knownAlternateDataDirs(activeDataDir: string): string[] {
  const candidates = [
    path.join(os.homedir(), "Personal/zion-codex-pool/.data/prod"),
  ];
  return candidates.filter((d) => {
    if (path.resolve(d) === path.resolve(activeDataDir)) return false;
    const accounts = path.join(d, "accounts");
    try {
      return (
        fs.existsSync(accounts) &&
        fs.readdirSync(accounts).some((name) => {
          return fs.existsSync(path.join(accounts, name, "auth.json"));
        })
      );
    } catch {
      return false;
    }
  });
}

export function countAccountsOnDisk(dataDir: string): number {
  const accounts = path.join(dataDir, "accounts");
  if (!fs.existsSync(accounts)) return 0;
  try {
    return fs.readdirSync(accounts).filter((name) => {
      return fs.existsSync(path.join(accounts, name, "auth.json"));
    }).length;
  } catch {
    return 0;
  }
}
