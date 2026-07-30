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

/** Filesystem account store under DATA_DIR/accounts/<id>/{auth.json,meta.json} */
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

  setQuota(id: string, quota: QuotaInfo): void {
    const rec = this.get(id);
    if (!rec) return;
    this.saveMeta({ ...rec.meta, quota, email: quota.email ?? rec.meta.email });
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
    const meta: AccountState = {
      ...(existing?.meta ?? { id }),
      id,
      label: label ?? existing?.meta.label,
      email: identity.email ?? existing?.meta.email,
      chatgptAccountId: identity.accountId ?? existing?.meta.chatgptAccountId,
    };
    this.saveMeta(meta);
    return { meta, auth };
  }
}
