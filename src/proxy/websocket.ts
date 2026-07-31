import { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import { AccountPool, TRANSIENT_COOLDOWN_MS } from "../accounts/pool.js";
import { refreshAuth, needsTokenRefresh } from "../auth/refresh.js";
import { accessToken, authIdentity } from "../auth/types.js";
import { extractSessionKey } from "./headers.js";

export interface WsProxyContext {
  pool: AccountPool;
  upstreamBase: string;
  /** e.g. wss://chatgpt.com/backend-api/codex/responses */
  upstreamWsUrl: string;
  /** Override only for tests; production retries after 1s, 2s, then 4s. */
  capacityRetryDelaysMs?: readonly number[];
}

const DEFAULT_CAPACITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const CAPACITY_PATTERNS = [
  "model_at_capacity",
  "selected model is at capacity",
  "server_is_overloaded",
  "service_unavailable_error",
] as const;

function frameText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return "";
}

export function isCapacityFrame(data: RawData): boolean {
  const lower = frameText(data).toLowerCase();
  return CAPACITY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function frameType(data: RawData): string | undefined {
  try {
    const parsed = JSON.parse(frameText(data)) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach a WebSocket upgrade handler for GET /backend-api/codex/responses.
 * Picks a pool account and pipes frames bidirectionally to ChatGPT. Capacity
 * errors received before any upstream response frame are retried on another
 * account with bounded backoff. Once upstream has emitted anything, replay is
 * disabled so a partially-started response can never execute twice.
 */
export function attachCodexWebSocket(
  wss: WebSocketServer,
  ctx: WsProxyContext
): void {
  wss.on("connection", async (client, req: IncomingMessage) => {
    const sessionKey = extractSessionKey(req);
    const retryDelays =
      ctx.capacityRetryDelaysMs ?? DEFAULT_CAPACITY_RETRY_DELAYS_MS;
    const triedAccountIds = new Set<string>();
    const replayableClientFrames: Array<{
      data: RawData;
      isBinary: boolean;
    }> = [];
    let upstream: WebSocket | undefined;
    let clientGone = false;
    let upstreamResponded = false;
    let capacityRetryCount = 0;
    let retryTimer: NodeJS.Timeout | undefined;

    const closeBoth = (code?: number, reason?: string) => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      try {
        if (client.readyState === WebSocket.OPEN) client.close(code, reason);
      } catch {
        /* ignore */
      }
      try {
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.close(code, reason);
        } else if (upstream?.readyState === WebSocket.CONNECTING) {
          // Aborting the handshake keeps a half-open upstream from spending
          // quota on a turn nobody is listening to anymore.
          upstream.terminate();
        }
      } catch {
        /* ignore */
      }
    };

    const pickNextAccount = () => {
      let account = ctx.pool.pick(sessionKey, triedAccountIds);
      // A one-account pool can still retry a transient model-wide capacity
      // event. Once every account was tried, allow another bounded pass.
      if (!account && triedAccountIds.size > 0) {
        triedAccountIds.clear();
        account = ctx.pool.pick(sessionKey);
      }
      return account;
    };

    const connectUpstream = async (): Promise<void> => {
      if (clientGone) return;
      const account = pickNextAccount();
      if (!account) {
        client.close(1013, "no healthy accounts");
        return;
      }
      triedAccountIds.add(account.meta.id);

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
      for (const key of ["openai-beta", "originator"]) {
        const value = req.headers[key];
        if (typeof value === "string") headers[key] = value;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(ctx.upstreamWsUrl, {
          headers,
          perMessageDeflate: false,
        });
      } catch (error) {
        client.close(
          1011,
          error instanceof Error ? error.message : "upstream connect failed"
        );
        return;
      }
      upstream = socket;

      socket.on("open", () => {
        if (clientGone || socket !== upstream) {
          socket.terminate();
          return;
        }
        ctx.pool.markUsed(account.meta.id, sessionKey);
        for (const frame of replayableClientFrames) {
          socket.send(frame.data, { binary: frame.isBinary });
        }
      });

      socket.on("message", (data, isBinary) => {
        if (socket !== upstream || clientGone) return;

        if (isCapacityFrame(data)) {
          // Model-wide capacity errors aren't this account's fault, but a
          // short cooldown still steers the *next* turn to a different
          // account instead of hammering the same overloaded one again.
          ctx.pool.markCooldown(account.meta.id, TRANSIENT_COOLDOWN_MS, {
            error: "model_at_capacity",
          });

          if (
            !upstreamResponded &&
            capacityRetryCount < retryDelays.length &&
            replayableClientFrames.length > 0
          ) {
            const delay = retryDelays[capacityRetryCount++];
            upstream = undefined;
            socket.terminate();
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void connectUpstream();
            }, delay);
            return;
          }
        }

        upstreamResponded = true;
        replayableClientFrames.length = 0;
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: isBinary });
        }
      });

      socket.on("close", (code, reason) => {
        if (socket !== upstream) return;
        closeBoth(code, reason.toString());
      });
      socket.on("error", () => {
        if (socket === upstream) closeBoth(1011, "upstream error");
      });
    };

    client.on("message", (data, isBinary) => {
      // A persistent connection carries many turns. Once a prior turn has
      // finished, a fresh "response.create" starts a new one — reopen the
      // capacity-retry window instead of leaving it permanently latched shut
      // by the first turn's success.
      if (upstreamResponded && frameType(data) === "response.create") {
        upstreamResponded = false;
        capacityRetryCount = 0;
        replayableClientFrames.length = 0;
        triedAccountIds.clear();
      }

      if (!upstreamResponded) {
        replayableClientFrames.push({ data, isBinary });
      }
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
      // While connecting or backing off, replayableClientFrames is flushed by
      // the next upstream "open" handler.
    });

    client.on("close", (code, reason) => {
      clientGone = true;
      replayableClientFrames.length = 0;
      closeBoth(code, reason.toString());
    });

    client.on("error", () => {
      clientGone = true;
      replayableClientFrames.length = 0;
      closeBoth(1011, "client error");
    });

    await connectUpstream();
  });
}
