import { describe, expect, it } from "vitest";
import { IncomingMessage } from "node:http";
import {
  checkFallbackError,
  getQuotaCooldown,
  maxPercentUsed,
  parseResetsAtMs,
  pickAccount,
} from "../src/accounts/pool.js";
import { AccountRecord } from "../src/auth/types.js";
import { authIdentity, decodeJwtPayload } from "../src/auth/types.js";
import { buildUpstreamHeaders } from "../src/proxy/headers.js";

function account(
  id: string,
  opts: {
    used?: number;
    cooldownUntil?: string;
    stickyDisabled?: boolean;
    authFailedAt?: string;
  } = {}
): AccountRecord {
  return {
    meta: {
      id,
      cooldownUntil: opts.cooldownUntil,
      stickyDisabled: opts.stickyDisabled,
      authFailedAt: opts.authFailedAt,
      quota: {
        weekly: { label: "Weekly", percentUsed: opts.used ?? 0 },
        updatedAt: new Date().toISOString(),
      },
    },
    auth: { tokens: { access_token: "x", refresh_token: "y" } },
  };
}

describe("maxPercentUsed", () => {
  it("takes the tighter window", () => {
    expect(
      maxPercentUsed({
        weekly: { label: "Weekly", percentUsed: 40 },
        session: { label: "5h", percentUsed: 90 },
      })
    ).toBe(90);
  });
});

describe("pickAccount", () => {
  it("prefers lowest quota under threshold", () => {
    const picked = pickAccount(
      [account("a", { used: 80 }), account("b", { used: 10 }), account("c", { used: 50 })],
      { skipThreshold: 95 }
    );
    expect(picked?.meta.id).toBe("b");
  });

  it("skips cooldown and exhausted", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const picked = pickAccount(
      [
        account("hot", { used: 99 }),
        account("cd", { used: 5, cooldownUntil: future }),
        account("ok", { used: 40 }),
      ],
      { skipThreshold: 95 }
    );
    expect(picked?.meta.id).toBe("ok");
  });

  it("pushes an auth-failed account to the back regardless of quota", () => {
    const failedAt = new Date().toISOString();
    const picked = pickAccount(
      [
        account("low-quota-but-401", { used: 5, authFailedAt: failedAt }),
        account("higher-quota-healthy", { used: 60 }),
      ],
      { skipThreshold: 95 }
    );
    expect(picked?.meta.id).toBe("higher-quota-healthy");
  });

  it("honors sticky preference when healthy", () => {
    const picked = pickAccount(
      [account("a", { used: 10 }), account("b", { used: 20 })],
      { skipThreshold: 95, preferId: "b" }
    );
    expect(picked?.meta.id).toBe("b");
  });
});

describe("checkFallbackError", () => {
  it("classifies 429 as backoff failover", () => {
    const d = checkFallbackError(429, "usage_limit_reached", 0);
    expect(d.shouldFallback).toBe(true);
    expect(d.newBackoffLevel).toBe(1);
    expect(d.cooldownMs).toBe(getQuotaCooldown(1));
  });

  it("classifies suspended as permanent", () => {
    const d = checkFallbackError(403, "Your account suspended", 0);
    expect(d.permanent).toBe(true);
  });
});

describe("parseResetsAtMs", () => {
  it("reads usage_limit_reached resets_at", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 120;
    const ms = parseResetsAtMs(
      JSON.stringify({ error: { type: "usage_limit_reached", resets_at: resetsAt } })
    );
    expect(ms).toBeGreaterThan(Date.now());
  });
});

describe("authIdentity", () => {
  it("decodes base64 jwt payload", () => {
    const payload = Buffer.from(
      JSON.stringify({
        email: "a@b.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc_1" },
      })
    ).toString("base64url");
    const token = `hdr.${payload}.sig`;
    expect(decodeJwtPayload(token)?.email).toBe("a@b.com");
    expect(
      authIdentity({ tokens: { access_token: token, account_id: "acc_1" } }).email
    ).toBe("a@b.com");
  });
});

describe("buildUpstreamHeaders", () => {
  it("preserves Codex request compression metadata", () => {
    const req = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
    } as IncomingMessage;

    const headers = buildUpstreamHeaders(account("a"), req, "session-1");
    expect(headers["content-encoding"]).toBe("zstd");
    expect(headers.session_id).toBe("session-1");
  });
});
