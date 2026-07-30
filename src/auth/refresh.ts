import {
  AuthJson,
  accessTokenExpiresAt,
  refreshToken,
  tokenRecord,
} from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const EXPIRY_SKEW_MS = 5 * 60_000;
const MAX_SESSION_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const RESULT_TTL_MS = 10_000;

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

const inFlight = new Map<string, Promise<AuthJson | undefined>>();
const recent = new Map<string, { auth: AuthJson; expiresAt: number }>();

export function needsTokenRefresh(auth: AuthJson | undefined, now = Date.now()): boolean {
  if (!auth || !refreshToken(auth)) return false;
  const expiresAt = accessTokenExpiresAt(auth);
  if (expiresAt !== undefined) {
    return expiresAt - EXPIRY_SKEW_MS <= now;
  }
  const lastRefresh = Date.parse(String(auth.last_refresh ?? ""));
  return Number.isNaN(lastRefresh) ? false : now - lastRefresh >= MAX_SESSION_AGE_MS;
}

async function requestRefresh(token: string): Promise<RefreshResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: token,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`refresh HTTP ${res.status}`);
    }
    return (await res.json()) as RefreshResponse;
  } finally {
    clearTimeout(timer);
  }
}

function withRefreshedTokens(auth: AuthJson, res: RefreshResponse): AuthJson | undefined {
  const current = tokenRecord(auth);
  if (!current || typeof res.access_token !== "string" || res.access_token.length === 0) {
    return undefined;
  }
  const tokens: Record<string, unknown> = { ...current, access_token: res.access_token };
  if (typeof res.id_token === "string" && res.id_token.length > 0) {
    tokens.id_token = res.id_token;
  }
  if (typeof res.refresh_token === "string" && res.refresh_token.length > 0) {
    tokens.refresh_token = res.refresh_token;
  }
  return { ...auth, tokens, last_refresh: new Date().toISOString() };
}

/**
 * Refresh ChatGPT OAuth tokens. Dedupes concurrent refreshes for the same
 * refresh_token (single-use rotation — same pattern as zion-gateway).
 */
export async function refreshAuth(auth: AuthJson, force = false): Promise<AuthJson | undefined> {
  const token = refreshToken(auth);
  if (!token) return undefined;
  if (!force && !needsTokenRefresh(auth)) return auth;

  const hit = recent.get(token);
  if (hit && hit.expiresAt > Date.now()) return hit.auth;

  const existing = inFlight.get(token);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const res = await requestRefresh(token);
      const next = withRefreshedTokens(auth, res);
      if (next) {
        recent.set(token, { auth: next, expiresAt: Date.now() + RESULT_TTL_MS });
        const newRefresh = refreshToken(next);
        if (newRefresh && newRefresh !== token) {
          recent.set(newRefresh, { auth: next, expiresAt: Date.now() + RESULT_TTL_MS });
        }
      }
      return next;
    } finally {
      inFlight.delete(token);
    }
  })();

  inFlight.set(token, promise);
  return promise;
}
