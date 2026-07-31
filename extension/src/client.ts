import { baseUrl, PoolSettings, readSettings } from "./settings";

export interface QuotaWindow {
  label?: string;
  percentUsed?: number;
  resetAt?: string;
}

export interface QuotaInfo {
  weekly?: QuotaWindow;
  session?: QuotaWindow;
  plan?: string;
  email?: string;
  updatedAt?: string;
  error?: string;
}

export interface AccountSummary {
  id: string;
  label?: string;
  email?: string;
  chatgptAccountId?: string;
  cooldownUntil?: string;
  stickyDisabled?: boolean;
  lastUsedAt?: string;
  lastError?: string;
  authFailedAt?: string;
  quota?: QuotaInfo;
  quotaUsed?: number;
}

export interface HealthInfo {
  ok: boolean;
  service?: string;
  accounts: number;
  ready: number;
}

export class PoolClient {
  constructor(private readonly getSettings: () => PoolSettings = readSettings) {}

  private headers(): Record<string, string> {
    return { Accept: "application/json" };
  }

  private url(pathname: string): string {
    return `${baseUrl(this.getSettings())}${pathname}`;
  }

  async health(): Promise<HealthInfo | undefined> {
    try {
      const res = await fetch(this.url("/health"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return undefined;
      return (await res.json()) as HealthInfo;
    } catch {
      return undefined;
    }
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const res = await fetch(this.url("/admin/accounts"), {
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`list accounts failed: HTTP ${res.status}`);
    const body = (await res.json()) as { accounts: AccountSummary[] };
    return body.accounts ?? [];
  }

  async refreshQuota(): Promise<number> {
    const res = await fetch(this.url("/admin/quota/refresh"), {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`quota refresh failed: HTTP ${res.status}`);
    const body = (await res.json()) as { accounts?: number };
    return body.accounts ?? 0;
  }

  async importAuth(auth: unknown, label?: string): Promise<{ id: string; email?: string }> {
    const res = await fetch(this.url("/admin/accounts/import"), {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(label ? { auth, label } : auth),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`import failed: HTTP ${res.status} ${text}`);
    }
    return (await res.json()) as { id: string; email?: string };
  }

  async deleteAccount(id: string): Promise<void> {
    const res = await fetch(this.url(`/admin/accounts/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`delete failed: HTTP ${res.status}`);
  }
}
