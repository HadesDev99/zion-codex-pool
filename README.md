# Zion Codex Pool

Local **Codex account pooler**. Point Codex CLI / IDE at `http://127.0.0.1:4000/backend-api/codex`
once, import multiple ChatGPT `auth.json` logins, and stop swapping `~/.codex/auth.json`.

Learns routing patterns from [zion-gateway](https://github.com/) / llm-router:
account cooldown + failover on 429, OAuth refresh dedupe, sticky session affinity,
and the ChatGPT Codex backend surface (`/backend-api/codex/*`) — not a generic `/v1` SDK proxy.

## Why

Independent from [Zion Switcher](https://github.com/HadesDev99/zion-switcher)
(separate account store). Switcher swaps one live `auth.json` at a time; this
pooler keeps every token in `~/.zion-codex-pool/accounts/` and picks per request:

```text
Codex CLI / IDE
    │  wire_api = responses, supports_websockets = true
    ▼
http://127.0.0.1:4000/backend-api/codex
    │  no client key needed on loopback
    │  pick account by quota + sticky session
    ▼
https://chatgpt.com/backend-api/codex/*
    with real ChatGPT access_token + chatgpt-account-id
```

## Quick start (extension UI)

Preferred for day-to-day use — open this repo (or install the VSIX) and press F5,
or:

```bash
npm run extension:install
npm run extension:build
# then Launch "Run Zion Codex Pool Extension"
```

From the **Zion Pool** sidebar: Start Pooler → Add account (login / import live
`auth.json` / import file) → Wire Codex to Pool. Status bar shows
`Pool ready/total · lowest%`.

## Quick start (CLI / server only)

```bash
cd zion-codex-pool
npm install
npm run dev
```

Import accounts (Codex `auth.json` shape):

```bash
npm run cli -- import-live
npm run cli -- import ~/.codex/auth.json --label work
npm run cli -- import-switcher   # optional escape hatch; not part of the extension UX
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
wire_api = "responses"
supports_websockets = true
requires_openai_auth = true
```

Keep a normal ChatGPT login in `~/.codex/auth.json` if you set
`requires_openai_auth = true` (Codex still wants a signed-in identity for IDE
features). Upstream ChatGPT tokens come from the pool, not from a pool API key.

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

The pooler is fixed to loopback (`127.0.0.1:4000`) and is not configurable
through environment variables.

## Behaviour (from llm-router patterns)

- **Pick**: sticky `session_id` / `prompt_cache_key` → else lowest quota under threshold
- **429 `usage_limit_reached`**: cooldown until `resets_at` (capped), try next account
- **Model capacity / overload**: retry WebSocket requests before output starts
  with bounded `1s → 2s → 4s` backoff; never replay a partial response
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

- Zion Switcher — separate product (one live auth.json); not shared with Pool
- zion-gateway `open-sse/executors/codex.js` — upstream header + Responses shape
- zion-gateway `open-sse/services/accountFallback.js` — cooldown / failover rules
