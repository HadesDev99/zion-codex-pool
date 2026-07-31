import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore, isOpaqueLabel } from "../src/accounts/store.js";
import { AuthJson } from "../src/auth/types.js";

const tempDirs: string[] = [];

function tempStore(): AccountStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zion-pool-store-"));
  tempDirs.push(dir);
  return new AccountStore(dir);
}

function authWithEmail(email: string, accountId: string): AuthJson {
  const payload = Buffer.from(
    JSON.stringify({
      email,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    })
  ).toString("base64url");
  return { tokens: { access_token: `hdr.${payload}.sig`, refresh_token: "r" } };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("isOpaqueLabel", () => {
  it("flags switcher directory ids and the live slot", () => {
    expect(isOpaqueLabel("a_mrx2wtle_fwmdhv")).toBe(true);
    expect(isOpaqueLabel("live")).toBe(true);
    expect(isOpaqueLabel("personal")).toBe(false);
    expect(isOpaqueLabel(undefined)).toBe(false);
  });
});

describe("importAuth", () => {
  it("stores the email and refuses a switcher-derived label", () => {
    const store = tempStore();
    const rec = store.importAuth(authWithEmail("me@x.com", "acc_1"), "a_mrx2wtle_fwmdhv");
    expect(rec.meta.email).toBe("me@x.com");
    expect(rec.meta.label).toBeUndefined();
  });

  it("keeps a meaningful label", () => {
    const store = tempStore();
    const rec = store.importAuth(authWithEmail("me@x.com", "acc_1"), "spare");
    expect(rec.meta.label).toBe("spare");
  });
});

describe("backfillIdentities", () => {
  it("re-derives email and drops the switcher label without touching tokens", () => {
    const store = tempStore();
    const auth = authWithEmail("me@x.com", "acc_1");
    const rec = store.importAuth(auth);
    store.saveMeta({ id: rec.meta.id, label: "a_mrx2wtle_fwmdhv" });

    expect(store.backfillIdentities()).toBe(1);

    const after = store.get(rec.meta.id);
    expect(after?.meta.email).toBe("me@x.com");
    expect(after?.meta.chatgptAccountId).toBe("acc_1");
    expect(after?.meta.label).toBeUndefined();
    expect(after?.auth).toEqual(auth);
  });

  it("is a no-op once accounts are clean", () => {
    const store = tempStore();
    store.importAuth(authWithEmail("me@x.com", "acc_1"), "spare");
    expect(store.backfillIdentities()).toBe(0);
  });
});
