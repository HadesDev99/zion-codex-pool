import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MANAGED_BEGIN = "# >>> zion-pool managed";
export const MANAGED_END = "# <<< zion-pool managed";

/** Minimal settings needed to wire Codex — avoids importing vscode in pure merge. */
export interface CodexWireSettings {
  host: string;
  port: number;
  poolApiKey?: string;
}

export function codexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function buildManagedBlock(settings: CodexWireSettings): string {
  const authLines = settings.poolApiKey
    ? `env_key = "CODEX_POOL_API_KEY"\n`
    : "";

  return (
    `${MANAGED_BEGIN}\n` +
    `model_provider = "zion-pool"\n` +
    `\n` +
    `[model_providers.zion-pool]\n` +
    `name = "OpenAI"\n` +
    `base_url = "http://${settings.host}:${settings.port}/backend-api/codex"\n` +
    authLines +
    `wire_api = "responses"\n` +
    `supports_websockets = true\n` +
    `requires_openai_auth = true\n` +
    `${MANAGED_END}\n`
  );
}

/** @deprecated Prefer buildManagedBlock — kept for docs/CLI snippets. */
export function buildPoolSnippet(settings: CodexWireSettings): string {
  return (
    `# Zion Codex Pool (managed by VS Code / Cursor extension)\n` +
    buildManagedBlock(settings)
  );
}

/**
 * Pure merge: strip prior zion-pool wiring, then insert one managed block in the
 * top-level region (before any `[table]`) so keys never leak into the wrong table.
 */
export function mergeCodexConfig(
  original: string,
  settings: CodexWireSettings
): string {
  let text = original.replace(/\r\n/g, "\n");

  // 1) Remove prior managed blocks (greedy per block).
  text = text.replace(
    new RegExp(
      `${escapeRegExp(MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`,
      "g"
    ),
    ""
  );

  // 2) Remove every [model_providers.zion-pool] table (header → next table / EOF).
  text = text.replace(
    /\[model_providers\.zion-pool\][^\n]*\n(?:[^\n[][^\n]*\n|\n)*/g,
    ""
  );

  // 3) Split into top-level preamble vs first table onward.
  const firstTable = text.search(/^\[/m);
  let preamble = firstTable === -1 ? text : text.slice(0, firstTable);
  const body = firstTable === -1 ? "" : text.slice(firstTable);

  // 4) Drop stale top-level model_provider lines from preamble only.
  preamble = preamble
    .split("\n")
    .filter((line) => !/^\s*model_provider\s*=/.test(line))
    .join("\n");

  // 5) Insert managed block at end of preamble (still top-level).
  const managed = buildManagedBlock(settings);
  preamble = `${preamble.replace(/\s+$/, "")}\n\n${managed}`;

  const bodyTrimmed = body.replace(/^\n+/, "");
  const merged =
    `${preamble.replace(/^\n+/, "")}` +
    (bodyTrimmed ? `\n${bodyTrimmed}` : "");
  return `${merged.replace(/\s+$/, "")}\n`;
}

/**
 * Ensure user-level ~/.codex/config.toml points Codex at the pooler.
 */
export function applyCodexConfig(settings?: CodexWireSettings): {
  path: string;
  created: boolean;
  changed: boolean;
} {
  // Lazy-load vscode settings only when callers omit explicit settings.
  const wire: CodexWireSettings = settings ?? readWireSettings();
  const file = codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, buildManagedBlock(wire), "utf8");
    return { path: file, created: true, changed: true };
  }

  const original = fs.readFileSync(file, "utf8");
  const next = mergeCodexConfig(original, wire);
  const changed = next !== original;
  if (changed) fs.writeFileSync(file, next, "utf8");
  return { path: file, created: false, changed };
}

function readWireSettings(): CodexWireSettings {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readSettings } = require("./settings") as typeof import("./settings");
  const s = readSettings();
  return { host: s.host, port: s.port, poolApiKey: s.poolApiKey };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
