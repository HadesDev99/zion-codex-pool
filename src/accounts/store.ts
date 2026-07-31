import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  AccountRecord,
  AccountState,
  AuthJson,
  QuotaInfo,
  authIdentity,
} from "../auth/types.js";

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function slugId(): string {
  return `a_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

// A refresh_token is single-use (rotates on every refresh). Two separate pool
// processes sharing the same data directory (e.g. one per editor) must not refresh
// the same account concurrently, or the loser reuses an already-invalidated
// token. `mkdir` is atomic across processes, so it doubles as a lock; a stale
// lock (owner crashed mid-refresh) is reclaimed after REFRESH_LOCK_STALE_MS.
const REFRESH_LOCK_STALE_MS = 30_000;
const REFRESH_LOCK_POLL_MS = 100;
const REFRESH_LOCK_WAIT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OPAQUE_ID_LABEL_RE = /^a_[a-z0-9]+_[a-z0-9]+$/i;

/**
 * Labels inherited from a zion-switcher import carry no meaning in the pool
 * (they are switcher directory ids, or its "live" slot name).
 */
export function isOpaqueLabel(label: string | undefined): boolean {
  if (!label) return false;
  const trimmed = label.trim();
  if (trimmed.length === 0) return true;
  return trimmed.toLowerCase() === "live" || OPAQUE_ID_LABEL_RE.test(trimmed);
}

function cleanLabel(label: string | undefined): string | undefined {
  return isOpaqueLabel(label) ? undefined : label;
}

/** Filesystem account store under <data-dir>/accounts/<id>/{auth.json,meta.json} */
export class AccountStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "accounts");
    ensureDir(this.root);
  }

  private accountDir(id: string): string {
    return path.join(this.root, id);
  }

  private authPath(id: string): string {
    return path.join(this.accountDir(id), "auth.json");
  }

  private metaPath(id: string): string {
    return path.join(this.accountDir(id), "meta.json");
  }

  listIds(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  get(id: string): AccountRecord | undefined {
    const auth = readJson<AuthJson>(this.authPath(id));
    if (!auth) return undefined;
    const meta =
      readJson<AccountState>(this.metaPath(id)) ??
      ({ id } satisfies AccountState);
    return { meta: { ...meta, id }, auth };
  }

  list(): AccountRecord[] {
    return this.listIds()
      .map((id) => this.get(id))
      .filter((a): a is AccountRecord => !!a);
  }

  saveAuth(id: string, auth: AuthJson): void {
    writeJsonAtomic(this.authPath(id), auth);
    const identity = authIdentity(auth);
    const existing = readJson<AccountState>(this.metaPath(id)) ?? { id };
    const next: AccountState = {
      ...existing,
      id,
      email: identity.email ?? existing.email,
      chatgptAccountId: identity.accountId ?? existing.chatgptAccountId,
    };
    writeJsonAtomic(this.metaPath(id), next);
  }

  saveMeta(meta: AccountState): void {
    writeJsonAtomic(this.metaPath(meta.id), meta);
  }

  private lockDir(id: string): string {
    return path.join(this.accountDir(id), ".refresh.lock");
  }

  /**
   * Acquire the cross-process refresh lock for an account, waiting up to
   * REFRESH_LOCK_WAIT_MS. Returns false if the wait timed out (caller should
   * still re-read the account and proceed — better a rare duplicate refresh
   * than a stuck request).
   */
  async acquireRefreshLock(id: string): Promise<boolean> {
    const dir = this.lockDir(id);
    ensureDir(this.accountDir(id));
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.mkdirSync(dir);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }

      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        continue; // lock disappeared between the mkdir attempt and stat — retry immediately
      }
      if (ageMs > REFRESH_LOCK_STALE_MS) {
        try {
          fs.rmdirSync(dir);
        } catch {
          /* ignore */
        }
        continue;
      }

      if (Date.now() >= deadline) return false;
      await sleep(REFRESH_LOCK_POLL_MS);
    }
  }

  releaseRefreshLock(id: string): void {
    try {
      fs.rmdirSync(this.lockDir(id));
    } catch {
      /* ignore */
    }
  }

  setQuota(id: string, quota: QuotaInfo): void {
    const rec = this.get(id);
    if (!rec) return;
    const email = rec.meta.email ?? quota.email ?? authIdentity(rec.auth).email;
    this.saveMeta({
      ...rec.meta,
      quota,
      email,
      label: email ? cleanLabel(rec.meta.label) : rec.meta.label,
    });
  }

  /**
   * Re-derive identity metadata (email, ChatGPT account id) from the stored
   * tokens for accounts that predate it, and drop switcher-derived labels once
   * an email is available. Tokens are never touched.
   *
   * @returns number of accounts whose meta.json changed.
   */
  backfillIdentities(): number {
    let updated = 0;
    for (const rec of this.list()) {
      const identity = authIdentity(rec.auth);
      const email = rec.meta.email ?? identity.email ?? rec.meta.quota?.email;
      const chatgptAccountId = rec.meta.chatgptAccountId ?? identity.accountId;
      const label = email ? cleanLabel(rec.meta.label) : rec.meta.label;
      if (
        email === rec.meta.email &&
        chatgptAccountId === rec.meta.chatgptAccountId &&
        label === rec.meta.label
      ) {
        continue;
      }
      const next: AccountState = { ...rec.meta, email, chatgptAccountId };
      if (label === undefined) delete next.label;
      else next.label = label;
      this.saveMeta(next);
      updated += 1;
    }
    return updated;
  }

  delete(id: string): boolean {
    const dir = this.accountDir(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Import a Codex auth.json. Dedupes by ChatGPT account identity.
   */
  importAuth(auth: AuthJson, label?: string): AccountRecord {
    const identity = authIdentity(auth);
    const existing = this.list().find((a) => {
      const other = authIdentity(a.auth);
      if (identity.accountId && other.accountId && identity.accountId === other.accountId) {
        if (identity.userId && other.userId) return identity.userId === other.userId;
        if (identity.email && other.email) {
          return identity.email.toLowerCase() === other.email.toLowerCase();
        }
        return true;
      }
      if (identity.email && other.email) {
        return identity.email.toLowerCase() === other.email.toLowerCase();
      }
      return false;
    });

    const id = existing?.meta.id ?? slugId();
    this.saveAuth(id, auth);
    const email = identity.email ?? existing?.meta.email;
    const meta: AccountState = {
      ...(existing?.meta ?? { id }),
      id,
      email,
      chatgptAccountId: identity.accountId ?? existing?.meta.chatgptAccountId,
    };
    // A switcher directory id as label would make the pool list mirror the
    // switcher's naming; the email already identifies the account.
    const nextLabel = cleanLabel(label ?? existing?.meta.label);
    if (nextLabel === undefined) delete meta.label;
    else meta.label = nextLabel;
    this.saveMeta(meta);
    return { meta, auth };
  }
}
