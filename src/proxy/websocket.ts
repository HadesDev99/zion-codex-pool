import { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { AccountPool } from "../accounts/pool.js";
import { refreshAuth, needsTokenRefresh } from "../auth/refresh.js";
import { accessToken, authIdentity } from "../auth/types.js";
import { extractSessionKey } from "./headers.js";

export interface WsProxyContext {
  pool: AccountPool;
  upstreamBase: string;
  /** e.g. wss://chatgpt.com/backend-api/codex/responses */
  upstreamWsUrl: string;
}

/**
 * Attach a WebSocket upgrade handler for GET /backend-api/codex/responses.
 * Picks a pool account and pipes frames bidirectionally to ChatGPT.
 */
export function attachCodexWebSocket(
  wss: WebSocketServer,
  ctx: WsProxyContext
): void {
  wss.on("connection", async (client, req: IncomingMessage) => {
    const sessionKey = extractSessionKey(req);
    const account = ctx.pool.pick(sessionKey);
    if (!account) {
      client.close(1013, "no healthy accounts");
      return;
    }

    let auth = account.auth;
    if (needsTokenRefresh(auth)) {
      auth = (await refreshAuth(auth)) ?? auth;
      ctx.pool.store.saveAuth(account.meta.id, auth);
    }

    const token = accessToken(auth);
    if (!token) {
      client.close(1011, "missing access_token");
      return;
    }

    const chatgptAccountId =
      account.meta.chatgptAccountId ?? authIdentity(auth).accountId;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.136.0",
    };
    if (chatgptAccountId) headers["chatgpt-account-id"] = chatgptAccountId;
    if (sessionKey) headers.session_id = sessionKey;

    // Forward selected client headers
    for (const key of ["openai-beta", "originator"]) {
      const v = req.headers[key];
      if (typeof v === "string") headers[key] = v;
    }

    let upstream: WebSocket;
    try {
      upstream = new WebSocket(ctx.upstreamWsUrl, {
        headers,
        perMessageDeflate: false,
      });
    } catch (e) {
      client.close(1011, e instanceof Error ? e.message : "upstream connect failed");
      return;
    }

    const closeBoth = (code?: number, reason?: string) => {
      try {
        if (client.readyState === WebSocket.OPEN) client.close(code, reason);
      } catch {
        /* ignore */
      }
      try {
        if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    upstream.on("open", () => {
      ctx.pool.markUsed(account.meta.id, sessionKey);
    });

    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });

    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });

    upstream.on("close", (code, reason) => {
      closeBoth(code, reason.toString());
    });
    client.on("close", (code, reason) => {
      closeBoth(code, reason.toString());
    });

    upstream.on("error", () => closeBoth(1011, "upstream error"));
    client.on("error", () => closeBoth(1011, "client error"));
  });
}
