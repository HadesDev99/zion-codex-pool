import { IncomingMessage, ServerResponse } from "node:http";
import { AccountPool, checkFallbackError, parseResetsAtMs } from "../accounts/pool.js";
import { refreshAuth, needsTokenRefresh } from "../auth/refresh.js";
import { AccountRecord } from "../auth/types.js";
import {
  buildUpstreamHeaders,
  decodeRequestBody,
  extractSessionKey,
  readBody,
} from "./headers.js";

const SSE_PEEK_BYTES = 16 * 1024;
const SSE_FALLBACK_PATTERNS = [
  "model_at_capacity",
  "selected model is at capacity",
  "server_is_overloaded",
  "service_unavailable_error",
  "usage_limit_reached",
  "experiencing high demand",
];

export interface ProxyContext {
  pool: AccountPool;
  upstreamBase: string;
}

function upstreamUrl(base: string, pathAfterCodex: string): string {
  // pathAfterCodex e.g. "/responses", "/models", "/responses/compact"
  return `${base}${pathAfterCodex}`;
}

function accountLabel(account: AccountRecord): string {
  return account.meta.email ?? account.meta.id;
}

async function ensureFresh(account: AccountRecord, pool: AccountPool): Promise<AccountRecord> {
  if (!needsTokenRefresh(account.auth)) return account;
  const id = account.meta.id;
  const locked = await pool.store.acquireRefreshLock(id);
  try {
    // Another process (e.g. a sibling pool sharing this data directory) may have
    // already refreshed this account while we were waiting for the lock.
    const current = pool.store.get(id) ?? account;
    if (!needsTokenRefresh(current.auth)) return current;
    const next = await refreshAuth(current.auth);
    if (!next) return current;
    pool.store.saveAuth(id, next);
    return pool.store.get(id) ?? { ...current, auth: next };
  } finally {
    if (locked) pool.store.releaseRefreshLock(id);
  }
}

async function forceRefresh(account: AccountRecord, pool: AccountPool): Promise<AccountRecord | undefined> {
  const id = account.meta.id;
  const locked = await pool.store.acquireRefreshLock(id);
  try {
    const current = pool.store.get(id) ?? account;
    const next = await refreshAuth(current.auth, true);
    if (!next) return undefined;
    pool.store.saveAuth(id, next);
    return pool.store.get(id);
  } finally {
    if (locked) pool.store.releaseRefreshLock(id);
  }
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

export async function peekSseFallback(
  response: Response
): Promise<{ response: Response; errorText?: string; status?: number }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
    return { response };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (text.length < SSE_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      text += decoder.decode(value, { stream: true });

      const lower = text.toLowerCase();
      const matched = SSE_FALLBACK_PATTERNS.find((pattern) => lower.includes(pattern));
      // response.failed is the Responses API's structured "upstream gave up
      // mid-stream" signal — treat it as a failure even when no known text
      // pattern matches (e.g. a new capacity-message wording we don't know yet).
      const failedEvent = !matched && text.includes("response.failed");
      if (matched || failedEvent) {
        await reader.cancel().catch(() => undefined);
        return {
          response,
          errorText: text,
          status: matched === "usage_limit_reached" ? 429 : 503,
        };
      }

      // Once real content starts flowing, stop buffering and stream it — but
      // wait for an actual content delta, not just the placeholder lifecycle
      // events (created/in_progress/output_item.added fire before any content
      // exists, so breaking on those alone can miss a canned apology message
      // that arrives as the very first delta).
      if (
        text.includes("response.output_text.delta") ||
        text.includes("response.completed") ||
        text.includes("response.done")
      ) {
        break;
      }
    }
  } catch {
    // Preserve already-read bytes and let the downstream stream surface errors.
  }

  const replacementBody = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return {
    response: new Response(replacementBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
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
  const bodyText = decodeRequestBody(bodyBuf, req.headers["content-encoding"]);
  const sessionKey = extractSessionKey(req, bodyText);

  const tried = new Set<string>();
  let lastStatus = 503;
  let lastBody = "No healthy Codex accounts in the pool";

  const maxAccountTries = Math.max(1, ctx.pool.store.listIds().length);
  for (let attempt = 0; attempt < maxAccountTries; attempt++) {
    let account = ctx.pool.pick(sessionKey, tried);
    if (!account) break;

    account = await ensureFresh(account, ctx.pool);
    tried.add(account.meta.id);
    console.log(
      `[proxy] ${pathAfterCodex} attempt ${attempt + 1}/${maxAccountTries} using ${accountLabel(account)}`
    );

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
      console.warn(`[proxy] ${accountLabel(account)} network error: ${msg}`);
      ctx.pool.markCooldown(account.meta.id, 30_000, { error: msg });
      lastBody = msg;
      lastStatus = 502;
      continue;
    }

    // Auth failure → one forced refresh + retry same account
    if (upstream.status === 401 || upstream.status === 403) {
      console.warn(
        `[proxy] ${accountLabel(account)} got ${upstream.status}, forcing token refresh`
      );
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
          console.log(
            `[proxy] ${accountLabel(account)} retried after refresh, status=${upstream.status}`
          );
        } catch (e) {
          console.warn(
            `[proxy] ${accountLabel(account)} retry after refresh threw: ${
              e instanceof Error ? e.message : String(e)
            }`
          );
        }
      } else {
        console.warn(`[proxy] ${accountLabel(account)} token refresh failed`);
      }
    }

    const peeked = await peekSseFallback(upstream);
    upstream = peeked.response;
    const effectiveStatus = peeked.status ?? upstream.status;

    if (effectiveStatus === 429 || effectiveStatus === 401 || effectiveStatus === 403 || effectiveStatus >= 500) {
      const errText =
        peeked.errorText ?? (await upstream.clone().text().catch(() => ""));
      const decision = checkFallbackError(
        effectiveStatus,
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
          authFailed: effectiveStatus === 401 || effectiveStatus === 403,
        });
        console.warn(
          `[proxy] ${accountLabel(account)} unavailable (${effectiveStatus}), cooldown ${Math.round(
            cooldownMs / 1000
          )}s, trying next account`
        );
        lastStatus = effectiveStatus;
        lastBody = errText || upstream.statusText;
        continue;
      }
    }

    // Success (or non-failover client error like 400) — stream through
    ctx.pool.markUsed(account.meta.id, sessionKey);
    res.setHeader("x-zion-account", accountLabel(account));
    pipeResponse(upstream, res);
    return;
  }

  console.warn(`[proxy] ${pathAfterCodex} exhausted all accounts, last status=${lastStatus}`);
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
