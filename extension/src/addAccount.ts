import * as vscode from "vscode";
import * as fs from "node:fs";
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

/**
 * Run `codex login` with CODEX_HOME pointed at a throwaway directory so it
 * *should* never touch the user's real ~/.codex/auth.json. In practice some
 * codex-cli versions still write (or otherwise disturb) the live file during
 * the OAuth callback regardless of CODEX_HOME — so this also snapshots the
 * live file before the login and restores it byte-for-byte afterward,
 * whichever path the fresh credentials actually landed in. Net effect on
 * ~/.codex is always zero, independent of codex-cli's internals.
 */
async function loginWithCodexTerminal(opts: {
  client: PoolClient;
  settings: PoolSettings;
  log: (line: string) => void;
  terminalName: string;
  waitingMessage: string;
}): Promise<{ id: string; email?: string } | undefined> {
  const pendingId = `login_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const codexHome = path.join(opts.settings.dataDir, "login-pending", pendingId);
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const authPath = path.join(codexHome, "auth.json");
  const livePath = liveCodexAuthPath();
  const liveBackup = fs.existsSync(livePath) ? fs.readFileSync(livePath) : undefined;

  const terminal = vscode.window.createTerminal({
    name: opts.terminalName,
    cwd: codexHome,
    env: { CODEX_HOME: codexHome },
  });
  terminal.show();
  terminal.sendText("codex login");

  void vscode.window.showInformationMessage(opts.waitingMessage);

  const imported = await waitForAuthAndImport(
    { isolatedPath: authPath, livePath, liveBackup },
    opts.client,
    opts.log,
    10 * 60_000
  );

  restoreLiveAuth(livePath, liveBackup, opts.log);

  // Best-effort cleanup of the isolated login home (auth already imported).
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return imported;
}

/** Put ~/.codex/auth.json back exactly as it was before this login attempt. */
function restoreLiveAuth(
  livePath: string,
  liveBackup: Buffer | undefined,
  log: (line: string) => void
): void {
  try {
    if (liveBackup) {
      if (!fs.existsSync(livePath) || !fs.readFileSync(livePath).equals(liveBackup)) {
        fs.writeFileSync(livePath, liveBackup, { mode: 0o600 });
        log(`restored ${livePath} to its pre-login state`);
      }
    } else if (fs.existsSync(livePath)) {
      fs.rmSync(livePath, { force: true });
      log(`removed ${livePath} written by codex login (there was none before)`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`failed to restore ${livePath}: ${msg}`);
  }
}

async function loginWithCodex(opts: {
  client: PoolClient;
  settings: PoolSettings;
  refreshUi: () => Promise<void>;
  log: (line: string) => void;
}): Promise<void> {
  const imported = await loginWithCodexTerminal({
    ...opts,
    terminalName: "Codex login (Zion Pool)",
    waitingMessage:
      "Zion Pool: finish `codex login` in the terminal. The account will appear once auth.json is written.",
  });
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
}

/**
 * Re-authenticate an existing pool account whose ChatGPT session has died
 * (refresh_token revoked/expired — no amount of token refresh recovers that).
 * Runs the same isolated `codex login` as "Add account", but afterwards
 * checks that the account the user logged into is the SAME one — importAuth
 * dedupes by ChatGPT identity, so logging into the right account updates its
 * auth.json in place; logging into a different one would silently leave the
 * original still dead while creating/refreshing an unrelated entry.
 */
export async function runReloginAccount(opts: {
  client: PoolClient;
  settings: PoolSettings;
  refreshUi: () => Promise<void>;
  log: (line: string) => void;
  accountId: string;
  accountLabel: string;
}): Promise<void> {
  const imported = await loginWithCodexTerminal({
    client: opts.client,
    settings: opts.settings,
    log: opts.log,
    terminalName: "Codex relogin (Zion Pool)",
    waitingMessage: `Zion Pool: finish \`codex login\` as ${opts.accountLabel} in the terminal.`,
  });

  if (!imported) {
    void vscode.window.showWarningMessage(
      `Zion Pool: relogin for ${opts.accountLabel} timed out or was cancelled.`
    );
    return;
  }

  await opts.refreshUi();

  if (imported.id !== opts.accountId) {
    void vscode.window.showWarningMessage(
      `Zion Pool: logged into ${imported.email ?? imported.id}, which is a different account than ${opts.accountLabel}. ` +
        `That account was imported/refreshed instead — ${opts.accountLabel} is still logged out.`
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Zion Pool: ${imported.email ?? imported.id} is logged in again.`
  );
}

async function waitForAuthAndImport(
  paths: { isolatedPath: string; livePath: string; liveBackup: Buffer | undefined },
  client: PoolClient,
  log: (line: string) => void,
  timeoutMs: number
): Promise<{ id: string; email?: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Isolated CODEX_HOME is the expected landing spot for the fresh tokens.
    if (fs.existsSync(paths.isolatedPath)) {
      try {
        await sleep(400); // give codex a moment to finish writing
        const auth = readJsonFile(paths.isolatedPath);
        return await client.importAuth(auth);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`login import failed (will retry): ${msg}`);
      }
    }

    // Fallback: some codex-cli versions write the live file regardless of
    // CODEX_HOME. Detect that by content diff against the pre-login snapshot
    // — restoreLiveAuth() puts it back afterward either way.
    if (fs.existsSync(paths.livePath)) {
      let liveBytes: Buffer | undefined;
      try {
        liveBytes = fs.readFileSync(paths.livePath);
      } catch {
        liveBytes = undefined;
      }
      if (liveBytes && (!paths.liveBackup || !liveBytes.equals(paths.liveBackup))) {
        try {
          await sleep(400);
          const auth = JSON.parse(fs.readFileSync(paths.livePath, "utf8"));
          log(`codex login wrote ${paths.livePath} instead of the isolated CODEX_HOME — importing from there`);
          return await client.importAuth(auth);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log(`login import from live path failed (will retry): ${msg}`);
        }
      }
    }

    await sleep(1000);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
