# Zion Codex Pool

Local **Codex account pooler**. Point Codex CLI / IDE at `http://127.0.0.1:4000/backend-api/codex`
once, import multiple ChatGPT `auth.json` logins, and stop swapping `~/.codex/auth.json`.

Learns routing patterns from [zion-gateway](https://github.com/) / llm-router:
account cooldown + failover on 429, OAuth refresh dedupe, sticky session affinity,
and the ChatGPT Codex backend surface (`/backend-api/codex/*`) — not a generic `/v1` SDK proxy.

## Why

[Zion Switcher](https://github.com/HadesDev99/zion-switcher) safely switches the live
`auth.json`. That still needs a restart and one active account at a time.

This pooler keeps every token in `~/.zion-codex-pool/accounts/` and picks per request:

```text
Codex CLI / IDE
    │  wire_api = responses, supports_websockets = true
    ▼
http://127.0.0.1:4000/backend-api/codex
    │  Bearer POOL_API_KEY (client auth)
    │  pick account by quota + sticky session
    ▼
https://chatgpt.com/backend-api/codex/*
    with real ChatGPT access_token + chatgpt-account-id
```

## Quick start

```bash
cd zion-codex-pool
cp .env.example .env   # set POOL_API_KEY
npm install
npm run dev
```

Import accounts (Codex `auth.json` shape):

```bash
npm run cli -- import-live
npm run cli -- import ~/.codex/auth.json --label work
npm run cli -- import-switcher   # pull from Zion Switcher storage on this Mac
npm run cli -- list
npm run cli -- refresh-quota
npm run cli -- print-config
```

Wire Codex (`~/.codex/config.toml`):

```toml
model_provider = "zion-pool"

[model_providers.zion-pool]
name = "OpenAI"
base_url = "http://127.0.0.1:4000/backend-api/codex"
env_key = "CODEX_POOL_API_KEY"
wire_api = "responses"
supports_websockets = true
requires_openai_auth = true
```

```bash
export CODEX_POOL_API_KEY="change-me"   # same as POOL_API_KEY
```

Keep a normal ChatGPT login in `~/.codex/auth.json` if you set
`requires_openai_auth = true` (Codex still wants a signed-in identity for IDE
features). The pool key authenticates to the pooler; upstream uses pooled tokens.

## Endpoints

| Path | Role |
| --- | --- |
| `GET /health` | Liveness + account counts |
| `GET /backend-api/codex/models` | Proxied model catalog |
| `POST /backend-api/codex/responses` | HTTP/SSE Responses |
| `GET /backend-api/codex/responses` | WebSocket upgrade |
| `POST /backend-api/codex/responses/compact` | Compact |
| `GET /admin/accounts` | List pool state |
| `POST /admin/accounts/import` | Import auth JSON |
| `DELETE /admin/accounts/:id` | Remove account |
| `POST /admin/quota/refresh` | Refresh usage windows |

Admin + Codex routes require `Authorization: Bearer $POOL_API_KEY`.

## Behaviour (from llm-router patterns)

- **Pick**: sticky `session_id` / `prompt_cache_key` → else lowest quota under threshold
- **429 `usage_limit_reached`**: cooldown until `resets_at` (capped), try next account
- **401/403**: one forced OAuth refresh, then failover
- **5xx / network**: short cooldown, failover
- **Quota poll**: `chatgpt.com/backend-api/wham/usage` on a timer
- **Refresh**: `auth.openai.com/oauth/token` with Codex CLI client id, in-flight dedupe

## Data layout

```text
~/.zion-codex-pool/
└── accounts/
    └── <id>/
        ├── auth.json    # Codex credential (mode 0600)
        └── meta.json    # cooldown, quota cache, label
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run with tsx |
| `npm run build && npm start` | Production |
| `npm test` | Unit tests |
| `npm run cli -- …` | Account import / list |

## Limits / ToS

Pooling multiple personal ChatGPT subscriptions behind one local endpoint may
violate OpenAI terms. This is a personal automation tool, not a multi-tenant
reseller. Prefer accounts you own; do not expose the pooler beyond `127.0.0.1`.

## Related

- Zion Switcher — interactive account switch in VS Code
- zion-gateway `open-sse/executors/codex.js` — upstream header + Responses shape
- zion-gateway `open-sse/services/accountFallback.js` — cooldown / failover rules
