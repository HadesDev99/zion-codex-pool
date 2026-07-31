import {
  AuthJson,
  QuotaInfo,
  QuotaWindow,
  accessToken,
  authIdentity,
} from "../auth/types.js";
import { refreshAuth, needsTokenRefresh } from "../auth/refresh.js";
import { AccountStore } from "./store.js";

interface ApiRateWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
}

const SESSION_MAX_SECONDS = 24 * 60 * 60;

function windowSeconds(window: ApiRateWindow): number | undefined {
  const seconds = window.limit_window_seconds;
  return typeof seconds === "number" && seconds > 0 ? seconds : undefined;
}

function windowLabel(seconds: number | undefined): string {
  if (seconds === undefined) return "Weekly";
  if (seconds < SESSION_MAX_SECONDS) return `${Math.round(seconds / 3600)}h`;
  return "Weekly";
}

function windowFromApi(window: ApiRateWindow | null | undefined): QuotaWindow | undefined {
  if (!window) return undefined;
  const parsed: QuotaWindow = { label: windowLabel(windowSeconds(window)) };
  if (typeof window.used_percent === "number") parsed.percentUsed = window.used_percent;
  if (typeof window.reset_at === "number") {
    parsed.resetAt = new Date(window.reset_at * 1000).toISOString();
  } else if (typeof window.reset_after_seconds === "number") {
    parsed.resetAt = new Date(Date.now() + window.reset_after_seconds * 1000).toISOString();
  }
  if (parsed.percentUsed === undefined && parsed.resetAt === undefined) return undefined;
  return parsed;
}

function splitRateLimitWindows(rateLimit: {
  primary_window?: ApiRateWindow | null;
  secondary_window?: ApiRateWindow | null;
}): { weekly?: QuotaWindow; session?: QuotaWindow } {
  const candidates = [rateLimit.primary_window, rateLimit.secondary_window].filter(
    (w): w is ApiRateWindow => w != null
  );
  const longest = (group: ApiRateWindow[]) =>
    group.length === 0
      ? undefined
      : group.reduce((a, b) => ((windowSeconds(a) ?? 0) >= (windowSeconds(b) ?? 0) ? a : b));
  const isSession = (w: ApiRateWindow) => {
    const s = windowSeconds(w);
    return s !== undefined && s <= SESSION_MAX_SECONDS;
  };
  return {
    weekly: windowFromApi(longest(candidates.filter((w) => !isSession(w)))),
    session: windowFromApi(longest(candidates.filter(isSession))),
  };
}

function errorQuota(message: string, email?: string): QuotaInfo {
  return {
    weekly: { label: "Weekly", percentUsed: undefined },
    error: message,
    email,
    updatedAt: new Date().toISOString(),
  };
}

export async function fetchQuota(auth: AuthJson): Promise<{ quota: QuotaInfo; auth: AuthJson }> {
  let current = auth;
  if (needsTokenRefresh(current)) {
    current = (await refreshAuth(current)) ?? current;
  }
  const token = accessToken(current);
  const email = authIdentity(current).email;
  if (!token) return { quota: errorQuota("Not signed in", email), auth: current };

  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) {
      const refreshed = await refreshAuth(current, true);
      if (refreshed) {
        return fetchQuota(refreshed);
      }
      return { quota: errorQuota("Unauthorized", email), auth: current };
    }
    if (!res.ok) {
      return { quota: errorQuota(`HTTP ${res.status}`, email), auth: current };
    }
    const value = (await res.json()) as {
      rate_limit?: {
        primary_window?: ApiRateWindow | null;
        secondary_window?: ApiRateWindow | null;
      };
      plan_type?: string;
    };
    if (!value.rate_limit) {
      return { quota: errorQuota("No usage data", email), auth: current };
    }
    const { weekly, session } = splitRateLimitWindows(value.rate_limit);
    return {
      quota: {
        weekly: weekly ?? { label: "Weekly" },
        session,
        plan: typeof value.plan_type === "string" ? value.plan_type : undefined,
        email,
        updatedAt: new Date().toISOString(),
      },
      auth: current,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { quota: errorQuota(msg, email), auth: current };
  }
}

export async function refreshAllQuotas(store: AccountStore): Promise<void> {
  store.backfillIdentities();
  for (const account of store.list()) {
    const { quota, auth } = await fetchQuota(account.auth);
    // Only write back when fetchQuota actually rotated the tokens — an
    // unconditional write here would clobber a concurrent import/relogin
    // (e.g. via /admin/accounts/import) that landed on disk after store.list()
    // took its snapshot, reintroducing the very "still 401 after relogin" bug
    // this account state was supposed to fix.
    if (auth !== account.auth) store.saveAuth(account.meta.id, auth);
    store.setQuota(account.meta.id, quota);
  }
}
