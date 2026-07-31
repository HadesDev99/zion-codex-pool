import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { AccountPool } from "../src/accounts/pool.js";
import { AccountStore } from "../src/accounts/store.js";
import { AuthJson } from "../src/auth/types.js";
import { handleAdmin } from "../src/routes/http.js";

const tempDirs: string[] = [];

function tempPool(): AccountPool {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zion-pool-http-"));
  tempDirs.push(dir);
  return new AccountPool(new AccountStore(dir), 95);
}

function auth(): AuthJson {
  return { tokens: { access_token: "x", refresh_token: "y" } };
}

function fakeReq(pathname: string): IncomingMessage {
  return { method: "GET", url: pathname, headers: {} } as IncomingMessage;
}

function fakeRes(): ServerResponse & { body: () => unknown } {
  let chunk = "";
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (data?: string) => {
      if (data) chunk = data;
    },
    body: () => JSON.parse(chunk),
  };
  return res as unknown as ServerResponse & { body: () => unknown };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("GET /admin/accounts", () => {
  it("lists an auth-failed account after healthy ones regardless of directory order", async () => {
    const pool = tempPool();
    const failing = pool.store.importAuth(auth(), "failing");
    pool.store.importAuth(auth(), "healthy");
    pool.markCooldown(failing.meta.id, 30_000, { authFailed: true, error: "unauthorized" });

    const res = fakeRes();
    await handleAdmin(fakeReq("/admin/accounts"), res, pool, "");

    const body = res.body() as { accounts: { id: string; label?: string }[] };
    expect(body.accounts.map((a) => a.label)).toEqual(["healthy", "failing"]);
  });
});
