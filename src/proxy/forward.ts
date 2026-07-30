import { IncomingMessage, ServerResponse } from "node:http";
import { AccountPool, checkFallbackError, parseResetsAtMs } from "../accounts/pool.js";
import { refreshAuth, needsTokenRefresh } from "../auth/refresh.js";
import { AccountRecord } from "../auth/types.js";
import { buildUpstreamHeaders, extractSessionKey, readBody } from "./headers.js";

const MAX_ACCOUNT_TRIES = 4;

export interface ProxyContext {
  pool: AccountPool;
  upstreamBase: string;
}

function upstreamUrl(base: string, pathAfterCodex: string): string {
  // pathAfterCodex e.g. "/responses", "/models", "/responses/compact"
  return `${base}${pathAfterCodex}`;
}

async function ensureFresh(account: AccountRecord, pool: AccountPool): Promise<AccountRecord> {
  if (!needsTokenRefresh(account.auth)) return account;
  const next = await refreshAuth(account.auth);
  if (!next) return account;
  pool.store.saveAuth(account.meta.id, next);
  return pool.store.get(account.meta.id) ?? { ...account, auth: next };
}

async function forceRefresh(account: AccountRecord, pool: AccountPool): Promise<AccountRecord | undefined> {
  const next = await refreshAuth(account.auth, true);
  if (!next) return undefined;
  pool.store.saveAuth(account.meta.id, next);
  return pool.store.get(account.meta.id);
}

function pipeResponse(upstream: Response, res: ServerResponse): void {
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "transfer-encoding" || lower === "connection" || lower === "content-encoding") {
      return;
    }
    res.setHeader(key, value);
  });
  res.setHeader("x-zion-pool", "1");

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const pump = (): void => {
    reader
      .read()
      .then(({ done, value }) => {
        if (done) {
          res.end();
          return;
        }
        if (value) {
          const ok = res.write(Buffer.from(value));
          if (!ok) {
            res.once("drain", pump);
            return;
          }
        }
        pump();
      })
      .catch((err) => {
        res.destroy(err instanceof Error ? err : undefined);
      });
  };
  pump();
}

/**
 * Forward a Codex backend path with account failover.
 * pathAfterCodex: "/responses" | "/models" | "/responses/compact"
 */
export async function forwardCodexRequest(
  ctx: ProxyContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathAfterCodex: string
): Promise<void> {
  const method = req.method ?? "GET";
  const bodyBuf = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
  const bodyText = bodyBuf?.toString("utf8");
  const sessionKey = extractSessionKey(req, bodyText);

  const tried = new Set<string>();
  let lastStatus = 503;
  let lastBody = "No healthy Codex accounts in the pool";

  for (let attempt = 0; attempt < MAX_ACCOUNT_TRIES; attempt++) {
    let account = ctx.pool.pick(sessionKey, tried);
    if (!account) break;

    account = await ensureFresh(account, ctx.pool);
    tried.add(account.meta.id);

    const url = upstreamUrl(ctx.upstreamBase, pathAfterCodex);
    let headers: Record<string, string>;
    try {
      headers = buildUpstreamHeaders(account, req, sessionKey);
    } catch (e) {
      lastBody = e instanceof Error ? e.message : String(e);
      lastStatus = 500;
      continue;
    }

    const body: BodyInit | undefined =
      bodyBuf && bodyBuf.length > 0 ? new Uint8Array(bodyBuf) : undefined;

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.pool.markCooldown(account.meta.id, 30_000, { error: msg });
      lastBody = msg;
      lastStatus = 502;
      continue;
    }

    // Auth failure → one forced refresh + retry same account
    if (upstream.status === 401 || upstream.status === 403) {
      const refreshed = await forceRefresh(account, ctx.pool);
      if (refreshed) {
        try {
          headers = buildUpstreamHeaders(refreshed, req, sessionKey);
          upstream = await fetch(url, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(10 * 60_000),
          });
          account = refreshed;
        } catch {
          /* fall through to failover */
        }
      }
    }

    if (upstream.status === 429 || upstream.status >= 500) {
      const errText = await upstream.clone().text().catch(() => "");
      const decision = checkFallbackError(
        upstream.status,
        errText,
        account.meta.backoffLevel ?? 0
      );
      if (decision.shouldFallback) {
        const resetsAt = parseResetsAtMs(errText);
        const cooldownMs = resetsAt
          ? Math.max(0, resetsAt - Date.now())
          : decision.cooldownMs;
        ctx.pool.markCooldown(account.meta.id, cooldownMs, {
          backoffLevel: decision.newBackoffLevel,
          error: errText.slice(0, 500),
          permanent: decision.permanent,
        });
        lastStatus = upstream.status;
        lastBody = errText || upstream.statusText;
        continue;
      }
    }

    // Success (or non-failover client error like 400) — stream through
    ctx.pool.markUsed(account.meta.id, sessionKey);
    res.setHeader("x-zion-account", account.meta.email ?? account.meta.id);
    pipeResponse(upstream, res);
    return;
  }

  res.statusCode = lastStatus;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      error: {
        message: lastBody,
        type: lastStatus === 429 ? "rate_limit_error" : "server_error",
        code: "zion_pool_exhausted",
      },
    })
  );
}
