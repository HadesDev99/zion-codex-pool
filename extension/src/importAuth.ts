import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function liveCodexAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
