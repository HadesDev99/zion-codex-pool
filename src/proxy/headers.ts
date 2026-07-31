import { IncomingMessage } from "node:http";
import zlib from "node:zlib";
import { accessToken, AccountRecord, authIdentity } from "../auth/types.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
]);

/** Headers Codex CLI/IDE commonly send that we should forward upstream. */
const FORWARD_ALLOW = new Set([
  "accept",
  "accept-encoding",
  "content-encoding",
  "content-type",
  "openai-beta",
  "originator",
  "user-agent",
  "session_id",
  "x-request-id",
  "chatgpt-account-id",
]);

export function buildUpstreamHeaders(
  account: AccountRecord,
  incoming: IncomingMessage,
  sessionId?: string
): Record<string, string> {
  const token = accessToken(account.auth);
  if (!token) {
    throw new Error(`account ${account.meta.id} has no access_token`);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.136.0",
    Accept: "text/event-stream, application/json",
  };

  const chatgptAccountId =
    account.meta.chatgptAccountId ?? authIdentity(account.auth).accountId;
  if (chatgptAccountId) {
    headers["chatgpt-account-id"] = chatgptAccountId;
  }

  if (sessionId) {
    headers.session_id = sessionId;
  }

  for (const [key, value] of Object.entries(incoming.headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (!FORWARD_ALLOW.has(lower) && !lower.startsWith("x-openai") && !lower.startsWith("openai-")) {
      continue;
    }
    // Prefer account-bound chatgpt-account-id over client value
    if (lower === "chatgpt-account-id" && headers["chatgpt-account-id"]) continue;
    if (lower === "authorization") continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  if (!headers["content-type"] && (incoming.method === "POST" || incoming.method === "PUT")) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

/**
 * Codex compresses request bodies for OpenAI-family providers. The compressed
 * bytes are forwarded untouched, so decode a copy here purely to read routing
 * hints such as `prompt_cache_key`.
 */
export function decodeRequestBody(
  body: Buffer | undefined,
  contentEncoding: string | string[] | undefined
): string | undefined {
  if (!body || body.length === 0) return undefined;

  const encoding = (Array.isArray(contentEncoding) ? contentEncoding.join(",") : contentEncoding ?? "")
    .trim()
    .toLowerCase();

  try {
    if (encoding === "" || encoding === "identity") return body.toString("utf8");
    if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(body).toString("utf8");
    if (encoding === "deflate") return zlib.inflateSync(body).toString("utf8");
    if (encoding === "br") return zlib.brotliDecompressSync(body).toString("utf8");
    if (encoding === "zstd") {
      const zstdDecompressSync = (
        zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }
      ).zstdDecompressSync;
      if (zstdDecompressSync) return zstdDecompressSync(body).toString("utf8");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function extractSessionKey(req: IncomingMessage, bodyText?: string): string | undefined {
  const fromHeader =
    (typeof req.headers.session_id === "string" && req.headers.session_id) ||
    (typeof req.headers["x-session-id"] === "string" && req.headers["x-session-id"]) ||
    undefined;
  if (fromHeader) return fromHeader.trim();

  if (!bodyText) return undefined;
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    for (const key of ["prompt_cache_key", "session_id", "conversation_id"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
