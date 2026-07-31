# CLAUDE.md

Guidance for agents working in this repository.

## What this is

Local Codex account **pooler** (not a billing gateway, not Zion Switcher).
Codex CLI/IDE talks to `http://127.0.0.1:4000/backend-api/codex`; the pooler
holds many ChatGPT OAuth `auth.json` files and fails over on quota/auth errors.

`extension/` is the VS Code / Cursor UI: spawn/stop the Node server, manage
accounts via `/admin/*`, wire `~/.codex/config.toml`. Do not import the pool
server into the extension host — always `spawn("node", [entry])`.

Sibling context:
- `../llm-router/zion-gateway` — production multi-provider gateway (patterns borrowed)
- `../llm-router/zion-switcher` — separate product (one live auth.json); Pool store is independent (CLI `import-switcher` is an optional escape hatch only)

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run cli -- import-live
npm run cli -- print-config
npm run extension:install
npm run extension:build
```

## Architecture

- `src/server.ts` — HTTP + WS upgrade
- `src/proxy/forward.ts` — HTTP/SSE forward with account retry loop
- `src/proxy/websocket.ts` — bidirectional WS pipe to ChatGPT
- `src/accounts/pool.ts` — pick / sticky / cooldown (from accountFallback)
- `src/accounts/quota.ts` — wham/usage poller
- `src/auth/refresh.ts` — OAuth refresh with dedupe
- `src/accounts/store.ts` — filesystem account store

Upstream is always `https://chatgpt.com/backend-api/codex/*` (Responses + models +
compact + WS). Do **not** reimplement translation to Chat Completions.

## Conventions

- TypeScript strict, ESM (`"type": "module"`)
- Never log access_token / refresh_token / request bodies
- Atomic writes for auth/meta JSON (mode 0600)
- Keep pooler bound to 127.0.0.1 by default

## Do not

- Point `chatgpt_base_url` at this pooler for app-server/identity routes
- Store plaintext secrets in the repo
- Add Postgres/Redis for the personal local use case unless asked
