// Keys: generated here from a cryptographically secure source, written once to the
// credentials directory with mode 600, read back when a run resumes, and never printed.
//
// Layout of the credentials directory (`--keys`, default ~/.near-credentials/<network>/):
//   <account>.json                          the full-access key, near-cli's legacy format
//   <account>/ed25519_<public key>.json     a function-call key, near-cli-rs's per-key layout,
//                                           with the contract it is for in `receiver_id`
//   weir-<suffix>.swarm-secret              the keeper's SWARM_SECRET
// Every file holds { account_id, public_key, private_key }. A file is created with O_EXCL, so an
// existing key is never overwritten.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { base58Decode, base58Encode, base64Encode, KeyPair } from "../../chain/src/tx.ts";

const REPO = resolve(new URL("../../", import.meta.url).pathname);

/** A 32-byte ed25519 seed from Web Crypto's CSPRNG. Tests may pass their own. */
export type SeedSource = () => Uint8Array;
export const secureSeed: SeedSource = () => crypto.getRandomValues(new Uint8Array(32));

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Replaces every known secret, in any of the encodings it could be printed in, with
 * `[redacted]`. Every log line, error message and output file goes through it. */
export class Redactor {
  readonly #needles = new Set<string>();

  add(secret: string): void {
    const forms = [secret];
    const m = /^ed25519:(.+)$/.exec(secret);
    if (m) {
      const bytes = base58Decode(m[1]!);
      const seed = bytes.slice(0, 32);
      forms.push(m[1]!, base58Encode(seed), hex(bytes), hex(seed), base64Encode(bytes), base64Encode(seed));
    }
    for (const f of forms) if (f.length >= 16) this.#needles.add(f);
  }

  redact(text: string): string {
    let out = text;
    for (const n of this.#needles) out = out.split(n).join("[redacted]");
    return out;
  }

  /** True if `text` holds a secret. */
  leaks(text: string): boolean {
    for (const n of this.#needles) if (text.includes(n)) return true;
    return false;
  }

  /** Throws (without quoting the secret) if `text` holds one. Used before writing any output
   * that must hold none: the state file, the record, deployments.json. */
  assertClean(text: string, where: string): void {
    if (this.leaks(text)) throw new Error(`refusing to write ${where}: it would contain a secret key`);
  }

  get size(): number {
    return this.#needles.size;
  }
}

interface KeyFile {
  account_id: string;
  public_key: string;
  private_key: string;
  receiver_id?: string;
  method_names?: string[];
  /** 1 for the first key of an account for a contract; `topup` adds the next when an allowance runs low. */
  generation?: number;
}

export function assertOutsideRepo(dir: string, what: string): void {
  const rel = relative(REPO, resolve(dir));
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) throw new Error(`${what} ${dir} is inside the repository; keys must live outside it`);
}

export class Keystore {
  readonly dir: string;
  readonly redactor: Redactor;
  readonly #seed: SeedSource;
  readonly #cache = new Map<string, KeyPair>();

  constructor(dir: string, opts: { seed?: SeedSource; redactor?: Redactor; allowInsideRepo?: boolean } = {}) {
    if (!opts.allowInsideRepo) assertOutsideRepo(dir, "the credentials directory");
    this.dir = resolve(dir);
    this.#seed = opts.seed ?? secureSeed;
    this.redactor = opts.redactor ?? new Redactor();
  }

  #ensureDir(d: string): void {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  #read(path: string): KeyFile {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) chmodSync(path, 0o600);
    const f = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
    this.redactor.add(f.private_key);
    return f;
  }

  async #pair(f: KeyFile, path: string): Promise<KeyPair> {
    let kp = this.#cache.get(path);
    if (!kp) {
      try {
        kp = await KeyPair.fromString(f.private_key);
      } catch {
        throw new Error(`${path} does not hold a valid ed25519 key`);
      }
      if (kp.publicKeyString !== f.public_key) throw new Error(`${path}: its public_key does not match its private_key`);
      this.#cache.set(path, kp);
    }
    return kp;
  }

  async #generate(): Promise<{ kp: KeyPair; secret: string }> {
    const seed = this.#seed();
    if (seed.length !== 32) throw new Error("a seed must be 32 bytes");
    const kp = await KeyPair.fromString(`ed25519:${base58Encode(seed)}`);
    const secret = `ed25519:${base58Encode(Uint8Array.from([...seed, ...kp.publicKey]))}`;
    this.redactor.add(secret);
    return { kp, secret };
  }

  #write(path: string, f: KeyFile): void {
    writeFileSync(path, JSON.stringify(f) + "\n", { mode: 0o600, flag: "wx" });
  }

  fullAccessPath(accountId: string): string {
    return join(this.dir, `${accountId}.json`);
  }

  /** The account's full-access key, or null if this directory has none for it. */
  async existingFullAccess(accountId: string): Promise<KeyPair | null> {
    const path = this.fullAccessPath(accountId);
    if (!existsSync(path)) return null;
    const f = this.#read(path);
    if (f.account_id !== accountId) throw new Error(`${path} is for ${f.account_id}`);
    return this.#pair(f, path);
  }

  /** The account's full-access key; generated and saved first if there is none yet. */
  async fullAccess(accountId: string): Promise<KeyPair> {
    const found = await this.existingFullAccess(accountId);
    if (found) return found;
    this.#ensureDir(this.dir);
    const { kp, secret } = await this.#generate();
    const path = this.fullAccessPath(accountId);
    this.#write(path, { account_id: accountId, public_key: kp.publicKeyString, private_key: secret });
    this.#cache.set(path, kp);
    return kp;
  }

  #fcFiles(accountId: string): { path: string; file: KeyFile }[] {
    const d = join(this.dir, accountId);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((n) => n.startsWith("ed25519_") && n.endsWith(".json"))
      .map((n) => ({ path: join(d, n), file: this.#read(join(d, n)) }));
  }

  /** The newest generation of `accountId`'s keys for `receiver`. */
  #current(accountId: string, receiver: string): { path: string; file: KeyFile } | undefined {
    return this.#fcFiles(accountId)
      .filter((x) => x.file.receiver_id === receiver)
      .sort((a, b) => (b.file.generation ?? 1) - (a.file.generation ?? 1))[0];
  }

  /** The generation of the current key, or 0 if there is none. */
  generationOf(accountId: string, receiver: string): number {
    const c = this.#current(accountId, receiver);
    return c ? (c.file.generation ?? 1) : 0;
  }

  /** Every key of `accountId` for `receiver` this directory holds, oldest first. */
  async allFunctionCall(accountId: string, receiver: string): Promise<{ key: KeyPair; generation: number }[]> {
    const files = this.#fcFiles(accountId).filter((x) => x.file.receiver_id === receiver);
    files.sort((a, b) => (a.file.generation ?? 1) - (b.file.generation ?? 1));
    return Promise.all(files.map(async (x) => ({ key: await this.#pair(x.file, x.path), generation: x.file.generation ?? 1 })));
  }

  /** The key that replaces generation `after` of `accountId` for `receiver`: generation `after + 1`,
   * created and saved if this directory does not hold it yet (so a resumed rotation reuses it). */
  async nextFunctionCall(accountId: string, receiver: string, methods: readonly string[], after: number): Promise<KeyPair> {
    const existing = this.#fcFiles(accountId).find((x) => x.file.receiver_id === receiver && (x.file.generation ?? 1) === after + 1);
    if (existing) return this.#pair(existing.file, existing.path);
    const d = join(this.dir, accountId);
    this.#ensureDir(d);
    const { kp, secret } = await this.#generate();
    const path = join(d, `${kp.publicKeyString.replace(":", "_")}.json`);
    this.#write(path, { account_id: accountId, public_key: kp.publicKeyString, private_key: secret, receiver_id: receiver, method_names: [...methods], generation: after + 1 });
    this.#cache.set(path, kp);
    return kp;
  }

  /** The function-call key of `accountId` for `receiver`; generated and saved first if there is none. */
  async functionCall(accountId: string, receiver: string, methods: readonly string[]): Promise<KeyPair> {
    const found = this.#current(accountId, receiver);
    if (found) return this.#pair(found.file, found.path);
    const d = join(this.dir, accountId);
    this.#ensureDir(d);
    const { kp, secret } = await this.#generate();
    const path = join(d, `${kp.publicKeyString.replace(":", "_")}.json`);
    this.#write(path, { account_id: accountId, public_key: kp.publicKeyString, private_key: secret, receiver_id: receiver, method_names: [...methods], generation: 1 });
    this.#cache.set(path, kp);
    return kp;
  }

  /** The function-call key of `accountId` for `receiver`, or null; never creates one. */
  async existingFunctionCall(accountId: string, receiver: string): Promise<KeyPair | null> {
    const found = this.#current(accountId, receiver);
    return found ? this.#pair(found.file, found.path) : null;
  }

  /** The secret of a function-call key, for keeper.env only. */
  functionCallSecret(accountId: string, receiver: string): string {
    const found = this.#current(accountId, receiver);
    if (!found) throw new Error(`no function-call key of ${accountId} for ${receiver} in ${this.dir}`);
    return found.file.private_key;
  }

  /** The keeper's SWARM_SECRET: 32 random bytes as hex, kept beside the keys so a re-run writes the same one. */
  swarmSecret(suffix: string): string {
    const path = join(this.dir, `weir-${suffix}.swarm-secret`);
    if (existsSync(path)) {
      const s = readFileSync(path, "utf8").trim();
      this.redactor.add(s);
      return s;
    }
    this.#ensureDir(this.dir);
    const s = hex(this.#seed());
    this.redactor.add(s);
    writeFileSync(path, s + "\n", { mode: 0o600, flag: "wx" });
    return s;
  }

  /** Loads every key file of these accounts into the redactor, so nothing printed can leak them. */
  loadAll(accountIds: readonly string[], suffix: string): void {
    for (const id of accountIds) {
      if (existsSync(this.fullAccessPath(id))) this.#read(this.fullAccessPath(id));
      this.#fcFiles(id);
    }
    const swarm = join(this.dir, `weir-${suffix}.swarm-secret`);
    if (existsSync(swarm)) this.redactor.add(readFileSync(swarm, "utf8").trim());
  }
}
