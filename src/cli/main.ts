#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../config.js";
import { AccountStore } from "../accounts/store.js";
import { AuthJson } from "../auth/types.js";
import { refreshAllQuotas } from "../accounts/quota.js";
import { maxPercentUsed } from "../accounts/pool.js";

function usage(): never {
  console.log(`zion-codex-pool CLI

Usage:
  zion-codex-pool import <path-to-auth.json> [--label NAME]
  zion-codex-pool import-live                 # import ~/.codex/auth.json
  zion-codex-pool import-switcher             # import from Zion Switcher globalStorage
  zion-codex-pool list
  zion-codex-pool delete <account-id>
  zion-codex-pool refresh-quota
  zion-codex-pool print-config                # print ~/.codex/config.toml snippet

Env: DATA_DIR, POOL_API_KEY, PORT, HOST
`);
  process.exit(1);
}

function switcherAccountsRoot(): string | undefined {
  const base = path.join(
    os.homedir(),
    "Library/Application Support/Code/User/globalStorage/hadesdev.zion-switcher/accounts/codex"
  );
  if (fs.existsSync(base)) return base;
  // VS Code Insiders / Cursor variants
  const alts = [
    path.join(
      os.homedir(),
      "Library/Application Support/Code - Insiders/User/globalStorage/hadesdev.zion-switcher/accounts/codex"
    ),
    path.join(
      os.homedir(),
      "Library/Application Support/Cursor/User/globalStorage/hadesdev.zion-switcher/accounts/codex"
    ),
  ];
  return alts.find((p) => fs.existsSync(p));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) usage();

  const config = loadConfig();
  const store = new AccountStore(config.dataDir);

  if (cmd === "import") {
    const file = args[1];
    if (!file) usage();
    const labelIdx = args.indexOf("--label");
    const label = labelIdx >= 0 ? args[labelIdx + 1] : undefined;
    const auth = JSON.parse(fs.readFileSync(file, "utf8")) as AuthJson;
    const rec = store.importAuth(auth, label);
    console.log(`Imported ${rec.meta.id} (${rec.meta.email ?? "no email"})`);
    return;
  }

  if (cmd === "import-live") {
    const live = path.join(os.homedir(), ".codex", "auth.json");
    const auth = JSON.parse(fs.readFileSync(live, "utf8")) as AuthJson;
    const rec = store.importAuth(auth, "live");
    console.log(`Imported live ${rec.meta.id} (${rec.meta.email ?? "no email"})`);
    return;
  }

  if (cmd === "import-switcher") {
    const root = switcherAccountsRoot();
    if (!root) {
      console.error("Zion Switcher account storage not found");
      process.exit(1);
    }
    let count = 0;
    for (const id of fs.readdirSync(root)) {
      const authPath = path.join(root, id, "auth.json");
      if (!fs.existsSync(authPath)) continue;
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthJson;
      const rec = store.importAuth(auth, id === "__default__" ? "switcher-default" : id);
      console.log(`  ${rec.meta.id} ← ${id} (${rec.meta.email ?? "?"})`);
      count++;
    }
    console.log(`Imported ${count} account(s) from Zion Switcher`);
    return;
  }

  if (cmd === "list") {
    for (const a of store.list()) {
      const used = maxPercentUsed(a.meta.quota);
      console.log(
        `${a.meta.id}\t${a.meta.email ?? "-"}\tquota=${a.meta.quota?.error ?? `${used}%`}\tcooldown=${a.meta.cooldownUntil ?? "-"}`
      );
    }
    return;
  }

  if (cmd === "delete") {
    const id = args[1];
    if (!id) usage();
    console.log(store.delete(id) ? `Deleted ${id}` : `Not found: ${id}`);
    return;
  }

  if (cmd === "refresh-quota") {
    await refreshAllQuotas(store);
    for (const a of store.list()) {
      console.log(
        `${a.meta.email ?? a.meta.id}: ${a.meta.quota?.error ?? `${maxPercentUsed(a.meta.quota)}%`}`
      );
    }
    return;
  }

  if (cmd === "print-config") {
    const key = config.poolApiKey === "change-me" ? "your-pool-key" : config.poolApiKey;
    console.log(`# Add to ~/.codex/config.toml (user-level, not project-local)
model_provider = "zion-pool"

[model_providers.zion-pool]
name = "OpenAI"
base_url = "http://${config.host}:${config.port}/backend-api/codex"
env_key = "CODEX_POOL_API_KEY"
wire_api = "responses"
supports_websockets = true
requires_openai_auth = true

# Then:
#   export CODEX_POOL_API_KEY="${key}"
`);
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
