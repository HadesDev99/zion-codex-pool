import { IncomingMessage, ServerResponse } from "node:http";
import { AccountPool, isInCooldown, maxPercentUsed, selectionRank } from "../accounts/pool.js";
import { refreshAllQuotas } from "../accounts/quota.js";
import { AuthJson } from "../auth/types.js";
import { forwardCodexRequest } from "../proxy/forward.js";
import { readBody } from "../proxy/headers.js";

/** Auth-dead accounts must not inflate /health ready (mirrors extension badge). */
function isAuthFailureMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /unauthorized|not signed in|missing(?:\s+\w+)*\s*token|invalid(?:\s+\w+)*\s*token|expired(?:\s+\w+)*\s*token|no refresh token/i.test(
    message
  );
}

export type SendJson = (res: ServerResponse, status: number, body: unknown) => void;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

export async function handleCodexHttp(
  req: IncomingMessage,
  res: ServerResponse,
  pool: AccountPool,
  upstreamBase: string
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/backend-api/codex")) return false;

  const suffix = url.pathname.slice("/backend-api/codex".length) || "";
  // Normalize: "" or "/" → models listing is separate; responses paths
  if (suffix === "/models" || suffix.startsWith("/models?")) {
    await forwardCodexRequest(
      { pool, upstreamBase },
      req,
      res,
      `/models${url.search}`
    );
    return true;
  }

  if (suffix === "/responses/compact" && req.method === "POST") {
    await forwardCodexRequest({ pool, upstreamBase }, req, res, "/responses/compact");
    return true;
  }

  if (
    (suffix === "/responses" || suffix.startsWith("/responses?")) &&
    (req.method === "POST" || req.method === "GET")
  ) {
    // GET without Upgrade is unusual; still forward as HTTP.
    await forwardCodexRequest(
      { pool, upstreamBase },
      req,
      res,
      `/responses${url.search}`
    );
    return true;
  }

  // Also accept OpenAI-style aliases some clients use
  if (suffix === "/v1/responses" && req.method === "POST") {
    await forwardCodexRequest({ pool, upstreamBase }, req, res, "/responses");
    return true;
  }

  sendJson(res, 404, {
    error: {
      message: `Unknown Codex backend path: ${url.pathname}`,
      hint: "Supported: /backend-api/codex/models, /responses, /responses/compact",
    },
  });
  return true;
}

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  pool: AccountPool
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/admin")) return false;

  if (url.pathname === "/admin/accounts" && req.method === "GET") {
    const accounts = pool.store
      .list()
      .sort((a, b) => selectionRank(a.meta) - selectionRank(b.meta))
      .map((a) => ({
        id: a.meta.id,
        label: a.meta.label,
        email: a.meta.email,
        chatgptAccountId: a.meta.chatgptAccountId,
        cooldownUntil: a.meta.cooldownUntil,
        stickyDisabled: a.meta.stickyDisabled,
        lastUsedAt: a.meta.lastUsedAt,
        lastError: a.meta.lastError,
        authFailedAt: a.meta.authFailedAt,
        quota: a.meta.quota,
        quotaUsed: maxPercentUsed(a.meta.quota),
      }));
    sendJson(res, 200, { accounts });
    return true;
  }

  if (url.pathname === "/admin/accounts/import" && req.method === "POST") {
    const raw = (await readBody(req)).toString("utf8");
    let auth: AuthJson;
    let label: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { auth?: AuthJson; label?: string } & AuthJson;
      if (parsed.auth && typeof parsed.auth === "object") {
        auth = parsed.auth;
        label = parsed.label;
      } else {
        auth = parsed;
      }
    } catch {
      sendJson(res, 400, { error: { message: "Invalid JSON auth.json body" } });
      return true;
    }
    const record = pool.store.importAuth(auth, label);
    sendJson(res, 200, {
      id: record.meta.id,
      email: record.meta.email,
      chatgptAccountId: record.meta.chatgptAccountId,
    });
    return true;
  }

  if (url.pathname.startsWith("/admin/accounts/") && req.method === "DELETE") {
    const id = url.pathname.slice("/admin/accounts/".length);
    if (!id || id.includes("/")) {
      sendJson(res, 400, { error: { message: "Bad account id" } });
      return true;
    }
    const ok = pool.store.delete(id);
    sendJson(res, ok ? 200 : 404, ok ? { deleted: id } : { error: { message: "Not found" } });
    return true;
  }

  if (url.pathname === "/admin/quota/refresh" && req.method === "POST") {
    await refreshAllQuotas(pool.store);
    sendJson(res, 200, { ok: true, accounts: pool.store.listIds().length });
    return true;
  }

  sendJson(res, 404, { error: { message: "Unknown admin route" } });
  return true;
}

export function handleHealth(req: IncomingMessage, res: ServerResponse, pool: AccountPool): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/health" && url.pathname !== "/") return false;
  const accounts = pool.store.list();
  // Ready ≈ routable: not suspended, not cooling down, not auth-dead.
  // (Expired cooldownUntil must not keep the account out of ready.)
  const ready = accounts.filter((a) => {
    if (a.meta.stickyDisabled) return false;
    if (isInCooldown(a.meta)) return false;
    const authMsg = a.meta.quota?.error ?? a.meta.lastError;
    if (authMsg && isAuthFailureMessage(authMsg)) return false;
    return true;
  });
  sendJson(res, 200, {
    ok: true,
    service: "zion-codex-pool",
    accounts: accounts.length,
    ready: ready.length,
  });
  return true;
}
