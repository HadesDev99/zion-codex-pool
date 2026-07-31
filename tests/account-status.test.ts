import { describe, expect, it } from "vitest";
import {
  accountDisplayName,
  accountRowDescription,
  accountRowLabel,
  compactEmailLabel,
  deriveAccountStatus,
  isAuthFailureMessage,
  isCooldownActive,
  isOpaqueLabel,
  quotaSummary,
} from "../extension/src/accountStatus.ts";

describe("isAuthFailureMessage", () => {
  it("matches known logout / token errors", () => {
    expect(isAuthFailureMessage("Unauthorized")).toBe(true);
    expect(isAuthFailureMessage("Not signed in")).toBe(true);
    expect(isAuthFailureMessage("missing access token")).toBe(true);
    expect(isAuthFailureMessage("HTTP 503")).toBe(false);
  });
});

describe("isCooldownActive", () => {
  it("only counts future cooldownUntil", () => {
    const now = Date.parse("2026-07-30T10:00:00.000Z");
    expect(isCooldownActive("2026-07-30T10:05:00.000Z", now)).toBe(true);
    expect(isCooldownActive("2026-07-30T09:59:00.000Z", now)).toBe(false);
    expect(isCooldownActive(undefined, now)).toBe(false);
  });
});

describe("deriveAccountStatus", () => {
  const now = Date.parse("2026-07-30T10:00:00.000Z");

  it("prioritizes stickyDisabled over everything", () => {
    const badge = deriveAccountStatus(
      {
        stickyDisabled: true,
        quotaUsed: 10,
        quota: { error: "Unauthorized" },
        cooldownUntil: "2026-07-30T11:00:00.000Z",
      },
      now
    );
    expect(badge).toMatchObject({
      kind: "disabled",
      icon: "circle-slash",
      description: "disabled",
    });
  });

  it("shows logged out for auth quota errors", () => {
    const badge = deriveAccountStatus(
      { quotaUsed: 0, quota: { error: "Not signed in" } },
      now
    );
    expect(badge).toMatchObject({
      kind: "logged_out",
      icon: "sign-out",
      description: "logged out",
    });
  });

  it("shows cooldown with minutes left", () => {
    const badge = deriveAccountStatus(
      { quotaUsed: 12, cooldownUntil: "2026-07-30T10:07:00.000Z" },
      now
    );
    expect(badge).toMatchObject({
      kind: "cooldown",
      icon: "watch",
      description: "cooldown · 7m",
    });
  });

  it("shows other quota errors as warning", () => {
    const badge = deriveAccountStatus({ quota: { error: "HTTP 503" } }, now);
    expect(badge).toMatchObject({
      kind: "error",
      icon: "warning",
      description: "HTTP 503",
    });
  });

  it("flags high usage with flame and percent", () => {
    const badge = deriveAccountStatus({ quotaUsed: 97 }, now);
    expect(badge).toMatchObject({
      kind: "high",
      icon: "flame",
      description: "97%",
    });
  });

  it("uses pass icon for healthy accounts (not account avatar)", () => {
    const badge = deriveAccountStatus({ quotaUsed: 42 }, now);
    expect(badge).toMatchObject({
      kind: "ready",
      icon: "pass",
      description: "42%",
    });
    expect(badge.icon).not.toBe("account");
  });
});

describe("isOpaqueLabel", () => {
  it("flags switcher-derived labels", () => {
    expect(isOpaqueLabel("a_mrx2wtle_fwmdhv")).toBe(true);
    expect(isOpaqueLabel("live")).toBe(true);
    expect(isOpaqueLabel("  ")).toBe(true);
  });

  it("keeps meaningful labels", () => {
    expect(isOpaqueLabel("work account")).toBe(false);
    expect(isOpaqueLabel(undefined)).toBe(false);
  });
});

describe("accountDisplayName", () => {
  it("prefers email over a switcher-derived label", () => {
    expect(
      accountDisplayName({ id: "a_1_b", label: "a_mrx2wtle_fwmdhv", email: "me@x.com" })
    ).toBe("me@x.com");
  });

  it("falls back to a meaningful label, then the id", () => {
    expect(accountDisplayName({ id: "a_1_b", label: "spare" })).toBe("spare");
    expect(accountDisplayName({ id: "a_1_b", label: "live" })).toBe("a_1_b");
  });
});

describe("compactEmailLabel", () => {
  it("keeps short emails unchanged", () => {
    expect(compactEmailLabel("me@x.com")).toBe("me@x.com");
    expect(compactEmailLabel("a@b.co")).toBe("a@b.co");
  });

  it("truncates a long Gmail local part and keeps @domain", () => {
    expect(compactEmailLabel("chungthigamnhien120@gmail.com")).toBe(
      "chungthigamnh…@gmail.com"
    );
  });

  it("truncates a long iCloud alias local part and keeps @domain", () => {
    expect(compactEmailLabel("63_cloaks_cacti+qoegln2@icloud.com")).toBe(
      "63_cloaks_ca…@icloud.com"
    );
  });

  it("falls back for malformed / no-@ strings", () => {
    expect(compactEmailLabel("not-an-email-address-at-all")).toBe(
      "not-an-email-address-at…"
    );
    expect(compactEmailLabel("@only-domain")).toBe("@only-domain");
  });
});

describe("accountRowLabel", () => {
  it("compacts long emails while displayName stays full", () => {
    const account = { email: "chungthigamnhien120@gmail.com", id: "a_1_b" };
    expect(accountRowLabel(account)).toBe("chungthigamnh…@gmail.com");
    expect(accountDisplayName(account)).toBe("chungthigamnhien120@gmail.com");
  });
});

describe("quotaSummary", () => {
  const now = Date.parse("2026-07-30T10:00:00.000Z");

  it("keeps weekly percent + reset compact (plan omitted)", () => {
    expect(
      quotaSummary(
        {
          quotaUsed: 88,
          quota: {
            weekly: { percentUsed: 88, resetAt: "2026-08-05T10:00:00.000Z" },
            plan: "plus",
          },
        },
        now
      )
    ).toBe("88% · 6d");
  });

  it("returns only percent when reset is missing", () => {
    expect(
      quotaSummary({ quotaUsed: 1, quota: { weekly: { percentUsed: 1 }, plan: "plus" } }, now)
    ).toBe("1%");
  });

  it("returns undefined when usage is unknown (plan stays in tooltip)", () => {
    expect(quotaSummary({ quota: { plan: "pro" } }, now)).toBeUndefined();
    expect(quotaSummary({}, now)).toBeUndefined();
  });
});

describe("accountRowDescription", () => {
  const now = Date.parse("2026-07-30T10:00:00.000Z");

  it("shows compact usage when ready (no plan / verbose words)", () => {
    const account = {
      quotaUsed: 1,
      quota: {
        weekly: { percentUsed: 1, resetAt: "2026-08-06T10:00:00.000Z" },
        plan: "plus",
      },
    };
    const badge = deriveAccountStatus(account, now);
    expect(accountRowDescription(account, badge, now)).toBe("1% · 7d");
  });

  it("shows compact usage for high-usage accounts", () => {
    const account = {
      quotaUsed: 97,
      quota: {
        weekly: { percentUsed: 97, resetAt: "2026-08-05T10:00:00.000Z" },
        plan: "plus",
      },
    };
    const badge = deriveAccountStatus(account, now);
    expect(badge.kind).toBe("high");
    expect(accountRowDescription(account, badge, now)).toBe("97% · 6d");
  });

  it("keeps cooldown primary with optional short percent", () => {
    const account = {
      quotaUsed: 20,
      cooldownUntil: "2026-07-30T10:07:00.000Z",
      quota: { weekly: { percentUsed: 20 } },
    };
    const badge = deriveAccountStatus(account, now);
    expect(accountRowDescription(account, badge, now)).toBe("cooldown · 7m · 20%");
  });

  it("keeps status badges alone without verbose usage", () => {
    const loggedOut = { quota: { error: "Unauthorized" } };
    expect(
      accountRowDescription(loggedOut, deriveAccountStatus(loggedOut, now), now)
    ).toBe("logged out");

    const disabled = { stickyDisabled: true, quotaUsed: 10 };
    expect(
      accountRowDescription(disabled, deriveAccountStatus(disabled, now), now)
    ).toBe("disabled");
  });
});
