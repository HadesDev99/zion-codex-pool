export type AuthJson = Record<string, unknown>;

export interface AuthIdentity {
  accountId?: string;
  subject?: string;
  userId?: string;
  email?: string;
}

export interface QuotaWindow {
  label: string;
  percentUsed?: number;
  resetAt?: string;
}

export interface QuotaInfo {
  weekly: QuotaWindow;
  session?: QuotaWindow;
  plan?: string;
  email?: string;
  updatedAt?: string;
  error?: string;
}

export interface AccountState {
  id: string;
  label?: string;
  email?: string;
  chatgptAccountId?: string;
  /** ISO timestamp — account skipped until then */
  cooldownUntil?: string;
  backoffLevel?: number;
  stickyDisabled?: boolean;
  lastError?: string;
  lastUsedAt?: string;
  quota?: QuotaInfo;
}

export interface AccountRecord {
  meta: AccountState;
  auth: AuthJson;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringField(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function tokenRecord(auth: AuthJson | undefined): Record<string, unknown> | undefined {
  const tokens = auth?.tokens;
  return tokens && typeof tokens === "object" ? (tokens as Record<string, unknown>) : undefined;
}

export function accessToken(auth: AuthJson | undefined): string | undefined {
  const value = tokenRecord(auth)?.access_token;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function refreshToken(auth: AuthJson | undefined): string | undefined {
  const value = tokenRecord(auth)?.refresh_token;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function authIdentity(auth: AuthJson | undefined): AuthIdentity {
  const identity: AuthIdentity = {};
  const tokens = tokenRecord(auth);
  if (!tokens) return identity;

  identity.accountId = stringField(tokens, "account_id");

  for (const key of ["id_token", "access_token"]) {
    const token = tokens[key];
    if (typeof token !== "string") continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    const authClaims = payload["https://api.openai.com/auth"];
    const profile = payload["https://api.openai.com/profile"];

    identity.subject = identity.subject ?? stringField(payload, "sub");
    identity.userId =
      identity.userId ??
      stringField(authClaims, "chatgpt_user_id") ??
      stringField(payload, "user_id");
    identity.email =
      identity.email ?? stringField(payload, "email") ?? stringField(profile, "email");
    identity.accountId =
      identity.accountId ??
      stringField(payload, "account_id") ??
      stringField(authClaims, "chatgpt_account_id") ??
      stringField(authClaims, "account_id");
  }
  return identity;
}

export function accessTokenExpiresAt(auth: AuthJson | undefined): number | undefined {
  const token = accessToken(auth);
  if (!token) return undefined;
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}
