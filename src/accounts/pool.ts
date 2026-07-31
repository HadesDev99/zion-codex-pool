import { AccountRecord, QuotaInfo } from "../auth/types.js";
import { AccountStore } from "./store.js";

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const BACKOFF_MAX_LEVEL = 15;
export const TRANSIENT_COOLDOWN_MS = 30_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;

export function maxPercentUsed(quota: QuotaInfo | undefined): number {
  if (!quota || quota.error) return 0;
  const values = [quota.session?.percentUsed, quota.weekly.percentUsed].filter(
    (n): n is number => typeof n === "number"
  );
  return values.length === 0 ? 0 : Math.max(...values);
}

export function isInCooldown(meta: AccountRecord["meta"], now = Date.now()): boolean {
  if (!meta.cooldownUntil) return false;
  return Date.parse(meta.cooldownUntil) > now;
}

/**
 * Rank accounts for selection: any account that failed a 401/403 even after a
 * forced token refresh sorts after every account that hasn't, regardless of
 * quota usage — it's effectively pushed to the back of the list until a
 * request against it succeeds again (markUsed clears authFailedAt).
 */
export function selectionRank(meta: AccountRecord["meta"]): number {
  return (meta.authFailedAt ? 1 : 0) * 1_000 + maxPercentUsed(meta.quota);
}

export function getQuotaCooldown(backoffLevel = 0): number {
  const level = Math.max(0, backoffLevel - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** level, BACKOFF_MAX_MS);
}

export interface FallbackDecision {
  shouldFallback: boolean;
  cooldownMs: number;
  newBackoffLevel?: number;
  permanent?: boolean;
}

/**
 * Port of zion-gateway open-sse/services/accountFallback checkFallbackError,
 * narrowed to Codex ChatGPT subscription errors.
 */
export function checkFallbackError(
  status: number,
  errorText: string,
  backoffLevel = 0
): FallbackDecision {
  const lower = errorText.toLowerCase();

  if (
    lower.includes("account suspended") ||
    lower.includes("temporarily_suspended") ||
    lower.includes("locked your account")
  ) {
    return { shouldFallback: true, cooldownMs: 0, permanent: true };
  }

  if (status === 429 || lower.includes("usage_limit_reached") || lower.includes("rate_limit")) {
    const newLevel = Math.min(backoffLevel + 1, BACKOFF_MAX_LEVEL);
    return {
      shouldFallback: true,
      cooldownMs: getQuotaCooldown(newLevel),
      newBackoffLevel: newLevel,
    };
  }

  if (status === 401 || status === 403) {
    return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
  }

  if (status >= 500) {
    return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
  }

  return { shouldFallback: false, cooldownMs: 0 };
}

interface UsageLimitError {
  resets_at?: number;
  resets_in_seconds?: number;
}

/**
 * Quota errors arrive either as a plain JSON body or as SSE frames, so collect
 * both the whole payload and every `data:` line as parse candidates.
 */
function jsonCandidates(bodyText: string): unknown[] {
  const found: unknown[] = [];
  const push = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
    try {
      found.push(JSON.parse(trimmed));
    } catch {
      /* ignore */
    }
  };

  push(bodyText);
  for (const line of bodyText.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0 && line.slice(0, separator).trim().toLowerCase() === "data") {
      push(line.slice(separator + 1));
    }
  }
  return found;
}

function findUsageLimitError(value: unknown, depth = 0): UsageLimitError | undefined {
  if (depth > 6 || !value || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findUsageLimitError(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "usage_limit_reached") return record as UsageLimitError;

  for (const nested of Object.values(record)) {
    const hit = findUsageLimitError(nested, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

export function parseResetsAtMs(bodyText: string): number | undefined {
  const now = Date.now();
  for (const candidate of jsonCandidates(bodyText)) {
    const err = findUsageLimitError(candidate);
    if (!err) continue;
    if (typeof err.resets_at === "number" && err.resets_at > 0) {
      const ms = err.resets_at * 1000;
      if (ms > now) return Math.min(ms, now + MAX_RATE_LIMIT_COOLDOWN_MS);
    }
    if (typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
      return Math.min(now + err.resets_in_seconds * 1000, now + MAX_RATE_LIMIT_COOLDOWN_MS);
    }
  }
  return undefined;
}

export interface PickOptions {
  skipThreshold: number;
  preferId?: string;
  excludeIds?: Set<string>;
  now?: number;
}

/**
 * Pick the healthiest account: sticky preference → lowest quota used → not cooling down.
 */
export function pickAccount(
  accounts: AccountRecord[],
  opts: PickOptions
): AccountRecord | undefined {
  const now = opts.now ?? Date.now();
  const exclude = opts.excludeIds ?? new Set<string>();

  const available = accounts.filter((a) => {
    if (exclude.has(a.meta.id)) return false;
    if (a.meta.stickyDisabled) return false;
    if (isInCooldown(a.meta, now)) return false;
    if (maxPercentUsed(a.meta.quota) >= opts.skipThreshold) return false;
    return !!a.auth;
  });

  if (available.length === 0) {
    // Soft fallback: ignore quota threshold but still respect cooldown
    const softened = accounts.filter(
      (a) => !exclude.has(a.meta.id) && !a.meta.stickyDisabled && !isInCooldown(a.meta, now)
    );
    return softened.sort((a, b) => selectionRank(a.meta) - selectionRank(b.meta))[0];
  }

  if (opts.preferId) {
    const preferred = available.find((a) => a.meta.id === opts.preferId);
    if (preferred) return preferred;
  }

  return available.sort((a, b) => selectionRank(a.meta) - selectionRank(b.meta))[0];
}

/** Sticky map: conversation/session key → account id */
export class StickyRouter {
  private readonly map = new Map<string, { accountId: string; lastUsed: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60 * 60_000) {
    this.ttlMs = ttlMs;
  }

  get(key: string | undefined): string | undefined {
    if (!key) return undefined;
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUsed > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    entry.lastUsed = Date.now();
    return entry.accountId;
  }

  set(key: string | undefined, accountId: string): void {
    if (!key) return;
    this.map.set(key, { accountId, lastUsed: Date.now() });
  }
}

export class AccountPool {
  readonly sticky = new StickyRouter();

  constructor(
    readonly store: AccountStore,
    readonly skipThreshold: number
  ) {}

  pick(sessionKey?: string, excludeIds?: Set<string>): AccountRecord | undefined {
    return pickAccount(this.store.list(), {
      skipThreshold: this.skipThreshold,
      preferId: this.sticky.get(sessionKey),
      excludeIds,
    });
  }

  markUsed(accountId: string, sessionKey?: string): void {
    const rec = this.store.get(accountId);
    if (!rec) return;
    // A successful upstream call proves auth works right now — a lingering
    // quota.error is just a stale result from an earlier failed poll (e.g. one
    // that raced a token refresh/import) and would otherwise keep the account
    // showing "logged out" until the next quota poll cycle overwrites it.
    const quota = rec.meta.quota;
    this.store.saveMeta({
      ...rec.meta,
      lastUsedAt: new Date().toISOString(),
      lastError: undefined,
      authFailedAt: undefined,
      quota: quota?.error ? { ...quota, error: undefined } : quota,
    });
    this.sticky.set(sessionKey, accountId);
  }

  markCooldown(
    accountId: string,
    cooldownMs: number,
    opts?: { backoffLevel?: number; error?: string; permanent?: boolean; authFailed?: boolean }
  ): void {
    const rec = this.store.get(accountId);
    if (!rec) return;
    const until =
      opts?.permanent || cooldownMs <= 0
        ? undefined
        : new Date(Date.now() + cooldownMs).toISOString();
    this.store.saveMeta({
      ...rec.meta,
      cooldownUntil: until,
      backoffLevel: opts?.backoffLevel ?? rec.meta.backoffLevel,
      stickyDisabled: opts?.permanent ? true : rec.meta.stickyDisabled,
      lastError: opts?.error,
      authFailedAt: opts?.authFailed ? new Date().toISOString() : rec.meta.authFailedAt,
    });
  }
}
