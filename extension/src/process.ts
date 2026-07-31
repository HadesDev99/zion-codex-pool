import * as vscode from "vscode";
import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PoolClient } from "./client";
import { PoolSettings, readSettings } from "./settings";

export class PoolProcessManager {
  private child: ChildProcess | undefined;
  private readonly output: vscode.OutputChannel;

  constructor(
    private readonly extensionPath: string,
    private readonly client: PoolClient
  ) {
    this.output = vscode.window.createOutputChannel("Zion Codex Pool");
  }

  get outputChannel(): vscode.OutputChannel {
    return this.output;
  }

  dispose(): void {
    void this.stop();
    this.output.dispose();
  }

  async isHealthy(): Promise<boolean> {
    return !!(await this.client.health());
  }

  async ensureRunning(settings = readSettings()): Promise<boolean> {
    if (await this.isHealthy()) return true;
    return this.start(settings);
  }

  async start(settings = readSettings()): Promise<boolean> {
    if (await this.isHealthy()) {
      this.output.appendLine("Pooler already healthy — skipping spawn.");
      return true;
    }

    const entry = resolveServerEntry(this.extensionPath, settings);
    if (!entry) {
      void vscode.window.showErrorMessage(
        "Zion Pool: không tìm thấy pooler. Chạy `npm run build` ở repo gốc, hoặc set zionPool.serverPath."
      );
      return false;
    }

    this.output.appendLine(`Starting pooler: node ${entry}`);
    this.output.appendLine(`DATA_DIR=${settings.dataDir} HOST=${settings.host} PORT=${settings.port}`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOST: settings.host,
      PORT: String(settings.port),
      DATA_DIR: settings.dataDir,
    };
    if (settings.poolApiKey) env.POOL_API_KEY = settings.poolApiKey;
    else delete env.POOL_API_KEY;

    try {
      // Prefer a real Node binary — process.execPath inside VS Code/Cursor is Electron.
      const nodeBin = process.env.NODE_BINARY || "node";
      this.child = spawn(nodeBin, [entry], {
        cwd: path.dirname(entry),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`spawn failed: ${msg}`);
      void vscode.window.showErrorMessage(`Zion Pool: spawn failed — ${msg}`);
      return false;
    }

    this.child.stdout?.on("data", (buf: Buffer) => this.output.append(buf.toString("utf8")));
    this.child.stderr?.on("data", (buf: Buffer) => this.output.append(buf.toString("utf8")));
    this.child.on("exit", (code, signal) => {
      this.output.appendLine(`pooler exited code=${code} signal=${signal ?? ""}`);
      this.child = undefined;
    });

    const ok = await this.waitHealthy(12_000);
    if (!ok) {
      void vscode.window.showErrorMessage(
        "Zion Pool: pooler không lên kịp. Xem Output → Zion Codex Pool."
      );
    }
    return ok;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;

    this.output.appendLine("Stopping pooler (SIGTERM)…");
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async waitHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return true;
      await sleep(250);
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve pooler entry:
 * 1. zionPool.serverPath setting
 * 2. extension/resources/pooler/index.js (packaged)
 * 3. sibling ../dist/index.js (dev monorepo checkout)
 */
export function resolveServerEntry(
  extensionPath: string,
  settings: PoolSettings = readSettings()
): string | undefined {
  const candidates = [
    settings.serverPath,
    path.join(extensionPath, "resources", "pooler", "index.js"),
    path.join(extensionPath, "..", "dist", "index.js"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
