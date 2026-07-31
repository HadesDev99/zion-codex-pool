/** Minimal account shape for status derivation (no vscode deps). */
export interface AccountStatusInput {
  stickyDisabled?: boolean;
  cooldownUntil?: string;
  lastError?: string;
  quotaUsed?: number;
  quota?: {
    error?: string;
    weekly?: { percentUsed?: number; resetAt?: string; label?: string };
    session?: { percentUsed?: number; resetAt?: string; label?: string };
    plan?: string;
  };
}

export type AccountStatusKind =
  | "disabled"
  | "logged_out"
  | "cooldown"
  | "error"
  | "high"
  | "ready";

export interface AccountStatusBadge {
  kind: AccountStatusKind;
  /** Codicon id for ThemeIcon (without $(…)). */
  icon: string;
  /** Short badge for TreeItem.description (right side). */
  description: string;
  /** Human label for tooltips. */
  statusLabel: string;
}

const AUTH_ERROR_RE =
  /unauthorized|not signed in|missing(?:\s+\w+)*\s*token|invalid(?:\s+\w+)*\s*token|expired(?:\s+\w+)*\s*token|no refresh token/i;

const HIGH_USAGE_THRESHOLD = 95;

export function isAuthFailureMessage(message: string | undefined): boolean {
  if (!message) return false;
  return AUTH_ERROR_RE.test(message);
}

export function isCooldownActive(
  cooldownUntil: string | undefined,
  now = Date.now()
): boolean {
  if (!cooldownUntil) return false;
  const until = Date.parse(cooldownUntil);
  return Number.isFinite(until) && until > now;
}

function cooldownMinutesLeft(cooldownUntil: string, now: number): number {
  const ms = Date.parse(cooldownUntil) - now;
  return Math.max(1, Math.ceil(ms / 60_000));
}

function percentLabel(quotaUsed: number | undefined): string {
  return typeof quotaUsed === "number" && Number.isFinite(quotaUsed)
    ? `${Math.round(quotaUsed)}%`
    : "?%";
}

/**
 * Derive tree-row status badge. Priority (high → low):
 * disabled → logged out → cooldown → quota error → high usage → ready.
 */
export function deriveAccountStatus(
  account: AccountStatusInput,
  now = Date.now()
): AccountStatusBadge {
  const pct = percentLabel(account.quotaUsed);

  if (account.stickyDisabled) {
    return {
      kind: "disabled",
      icon: "circle-slash",
      description: "disabled",
      statusLabel: "disabled / suspended",
    };
  }

  const quotaError = account.quota?.error;
  if (isAuthFailureMessage(quotaError) || isAuthFailureMessage(account.lastError)) {
    return {
      kind: "logged_out",
      icon: "sign-out",
      description: "logged out",
      statusLabel: "logged out",
    };
  }

  if (isCooldownActive(account.cooldownUntil, now) && account.cooldownUntil) {
    const mins = cooldownMinutesLeft(account.cooldownUntil, now);
    return {
      kind: "cooldown",
      icon: "watch",
      description: `cooldown · ${mins}m`,
      statusLabel: "cooldown",
    };
  }

  if (quotaError) {
    const short =
      quotaError.length > 24 ? `${quotaError.slice(0, 21)}…` : quotaError;
    return {
      kind: "error",
      icon: "warning",
      description: short || "error",
      statusLabel: "quota error",
    };
  }

  if (typeof account.quotaUsed === "number" && account.quotaUsed >= HIGH_USAGE_THRESHOLD) {
    return {
      kind: "high",
      icon: "flame",
      description: pct,
      statusLabel: "high usage",
    };
  }

  return {
    kind: "ready",
    icon: "pass",
    description: pct,
    statusLabel: "ready",
  };
}

const OPAQUE_ID_LABEL_RE = /^a_[a-z0-9]+_[a-z0-9]+$/i;

/**
 * A label inherited from a zion-switcher import (its directory id, or the
 * "live" slot name) says nothing about the account — the email does.
 */
export function isOpaqueLabel(label: string | undefined): boolean {
  if (!label) return false;
  const trimmed = label.trim();
  if (trimmed.length === 0) return true;
  return trimmed.toLowerCase() === "live" || OPAQUE_ID_LABEL_RE.test(trimmed);
}

/** Row title / tooltip identity: full email first, then a meaningful label, then the id. */
export function accountDisplayName(account: {
  id?: string;
  label?: string;
  email?: string;
}): string {
  if (account.email) return account.email;
  if (account.label && !isOpaqueLabel(account.label)) return account.label;
  return account.id ?? "account";
}

/**
 * Compact an email for tree-row labels. Preserves `@domain`; truncates only the
 * local part with `…` when the full address exceeds `maxLen` (default 24).
 * Short emails and strings without `@` are left alone (or mid-truncated if long).
 */
export function compactEmailLabel(email: string, maxLen = 24): string {
  const trimmed = email.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.length <= maxLen) return trimmed;

  const at = trimmed.lastIndexOf("@");
  if (at <= 0) {
    // Malformed / no domain — plain truncate.
    return `${trimmed.slice(0, Math.max(1, maxLen - 1))}…`;
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at); // includes @
  const localBudget = maxLen - 1 - domain.length; // room for local prefix + …
  if (localBudget < 1) {
    // Domain alone nearly fills the budget — keep a tiny local hint if possible.
    if (domain.length >= maxLen) return `…${domain.slice(-(maxLen - 1))}`;
    return `${local.slice(0, 1)}…${domain}`;
  }
  return `${local.slice(0, localBudget)}…${domain}`;
}

/** Compact tree-row label: visually short email, full address stays in tooltip. */
export function accountRowLabel(account: {
  id?: string;
  label?: string;
  email?: string;
}): string {
  if (account.email) return compactEmailLabel(account.email);
  return accountDisplayName(account);
}

/** Compact reset duration for tree rows, e.g. "7d" / "3h" / "12m". */
function formatResetCompact(resetAt: string | undefined, now: number): string | undefined {
  if (!resetAt) return undefined;
  const ms = Date.parse(resetAt) - now;
  if (!Number.isFinite(ms)) return undefined;
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Compact weekly usage for tree rows, e.g. "88% · 6d". Plan lives in the tooltip. */
export function quotaSummary(
  account: AccountStatusInput,
  now = Date.now()
): string | undefined {
  const weekly = account.quota?.weekly;
  const percent = weekly?.percentUsed ?? account.quotaUsed;
  const parts: string[] = [];
  if (typeof percent === "number" && Number.isFinite(percent)) {
    parts.push(`${Math.round(percent)}%`);
  }
  const resets = formatResetCompact(weekly?.resetAt, now);
  if (resets && parts.length > 0) parts.push(resets);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Right-side row text: compact usage for healthy/high accounts; clear short
 * status badges otherwise (plan / full detail stay in the tooltip).
 */
export function accountRowDescription(
  account: AccountStatusInput,
  badge: AccountStatusBadge,
  now = Date.now()
): string {
  const usage = quotaSummary(account, now);
  if (badge.kind === "ready") return usage ?? "no quota data";
  if (badge.kind === "high") return usage ?? badge.description;
  if (badge.kind === "cooldown") {
    // Keep cooldown primary; append only a short percent when available.
    const percent = account.quota?.weekly?.percentUsed ?? account.quotaUsed;
    if (typeof percent === "number" && Number.isFinite(percent)) {
      return `${badge.description} · ${Math.round(percent)}%`;
    }
    return badge.description;
  }
  return badge.description;
}

/** Full tooltip lines for an account row. */
export function accountStatusTooltipLines(
  account: AccountStatusInput & { email?: string; id?: string; lastUsedAt?: string },
  badge: AccountStatusBadge,
  dataDir?: string
): string[] {
  const lines: string[] = [
    accountDisplayName(account),
    `status: ${badge.statusLabel}`,
    `quota: ${percentLabel(account.quotaUsed)}`,
  ];
  if (account.id && account.id !== accountDisplayName(account)) {
    lines.push(`id: ${account.id}`);
  }

  if (account.stickyDisabled) lines.push("stickyDisabled: true");
  if (account.cooldownUntil) lines.push(`cooldownUntil: ${account.cooldownUntil}`);
  if (account.lastUsedAt) lines.push(`lastUsed: ${account.lastUsedAt}`);
  if (account.lastError) lines.push(`lastError: ${account.lastError}`);
  if (account.quota?.error) lines.push(`quota.error: ${account.quota.error}`);
  if (account.quota?.plan) lines.push(`plan: ${account.quota.plan}`);

  const weekly = account.quota?.weekly;
  if (weekly && (weekly.percentUsed != null || weekly.resetAt)) {
    lines.push(
      `weekly: ${weekly.percentUsed != null ? `${Math.round(weekly.percentUsed)}%` : "?"}${
        weekly.resetAt ? ` · reset ${weekly.resetAt}` : ""
      }`
    );
  }
  const session = account.quota?.session;
  if (session && (session.percentUsed != null || session.resetAt)) {
    lines.push(
      `session: ${session.percentUsed != null ? `${Math.round(session.percentUsed)}%` : "?"}${
        session.resetAt ? ` · reset ${session.resetAt}` : ""
      }`
    );
  }

  if (dataDir) lines.push(`DATA_DIR: ${dataDir}`);
  return lines;
}
