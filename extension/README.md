# Zion Codex Pool — VS Code / Cursor extension

UI layer for the local Codex account pooler. The extension starts/stops the Node
proxy, shows pool accounts + quota, imports credentials, and wires
`~/.codex/config.toml` so Codex CLI / IDE talk to the pool instead of a single
`auth.json`.

**Independent from Zion Switcher** — separate account store. Pool accounts live
under `~/.zion-codex-pool/`; Switcher manages its own live `~/.codex/auth.json`
switch. The two lists are not shared.

## What it does

| Action | Command |
|--------|---------|
| Start / stop pooler | `Zion Pool: Start Pooler` / `Stop Pooler` |
| Add account | `Add Account` (login / import live / import file) |
| Point Codex at the pool | `Wire Codex to Pool` |
| Refresh quotas | `Refresh Quotas` |

Sidebar **Zion Pool** lists accounts (email, % used, cooldown). Status bar shows
`Pool ready/total · lowest%`.

Routing stays automatic — there is no “switch account” button. That is the
point of the pooler.

## Dev

From the repo root:

```bash
npm run build                 # server
cd extension && npm install
npm run build                 # extension host bundle
```

Press F5 with a launch config that opens this folder as an Extension Development
Host, or:

```bash
# optional: package VSIX (bundles pooler into resources/pooler)
npm run package
```

Unset `zionPool.serverPath` in settings: the extension looks for
`resources/pooler/index.js` (packaged) then `../dist/index.js` (repo checkout).

## Settings

- `zionPool.autoStart` — spawn on activate (default on)
- `zionPool.host` / `zionPool.port` — must match Codex `base_url`
- `zionPool.dataDir` — empty → `~/.zion-codex-pool`
- `zionPool.poolApiKey` — optional; empty = open loopback
- `zionPool.applyConfigOnStart` — merge pool provider into `~/.codex/config.toml`
