// Base58 and base64, ed25519 keys in NEAR's string form, and the borsh encoding of a NEAR
// transaction made of function-call actions: the bytes that get hashed, signed and sent.
// Runs unchanged in Node, browsers and Cloudflare Workers (signing uses Web Crypto's SHA-512
// through @noble/ed25519's async API; hashing uses the engine's synchronous SHA-256).
import * as ed from "@noble/ed25519";
import { sha256 } from "@weir/engine";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const digit = B58.indexOf(ch);
    if (digit < 0) throw new Error(`invalid base58 character ${JSON.stringify(ch)}`);
    n = n * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n % 256n));
    n /= 256n;
  }
  let zeros = 0;
  while (text[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export const utf8Encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** An ed25519 key pair from a NEAR secret-key string `ed25519:<base58>`. */
export class KeyPair {
  readonly publicKey: Uint8Array;
  readonly #seed: Uint8Array;

  private constructor(seed: Uint8Array, publicKey: Uint8Array) {
    this.#seed = seed;
    this.publicKey = publicKey;
  }

  /** Accepts the 64-byte form NEAR tools write (seed then public key) or a bare 32-byte seed. */
  static async fromString(secretKey: string): Promise<KeyPair> {
    const [curve, data] = secretKey.split(":");
    if (curve !== "ed25519" || !data) throw new Error("secret key must look like ed25519:<base58>");
    const bytes = base58Decode(data);
    if (bytes.length !== 64 && bytes.length !== 32) throw new Error("ed25519 secret key must be 32 or 64 bytes");
    const seed = bytes.slice(0, 32);
    const publicKey = await ed.getPublicKeyAsync(seed);
    if (bytes.length === 64 && !equalBytes(publicKey, bytes.slice(32))) {
      throw new Error("secret key does not match its public key");
    }
    return new KeyPair(seed, publicKey);
  }

  /** `ed25519:<base58>`, as NEAR shows a public key. */
  get publicKeyString(): string {
    return `ed25519:${base58Encode(this.publicKey)}`;
  }

  sign(message: Uint8Array): Promise<Uint8Array> {
    return ed.signAsync(message, this.#seed);
  }
}

/** A function-call action (borsh enum index 2 of `Action`). */
export interface FunctionCall {
  methodName: string;
  args: Uint8Array;
  /** u64 gas units. */
  gas: bigint;
  /** u128 yoctoNEAR. */
  deposit: bigint;
}

/** An access key's permission (borsh enum `AccessKeyPermission`). */
export type KeyPermission = "FullAccess" | { receiverId: string; methodNames: string[]; allowance: bigint | null };

/** The account-setup actions, for deployments and tests: create an account, fund it, give it
 * a key, deploy code. A plain `FunctionCall` (no `type`) is still the common case. */
export type SetupAction =
  | { type: "CreateAccount" }
  | { type: "DeployContract"; code: Uint8Array }
  | { type: "Transfer"; deposit: bigint }
  | { type: "AddKey"; publicKey: Uint8Array; permission: KeyPermission };

export type Action = FunctionCall | SetupAction;

/** A transaction (V0) whose actions are all function calls; ed25519 keys only. */
export interface Transaction {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: FunctionCall[];
}

/** A transaction that may also carry setup actions. */
export interface AnyTransaction extends Omit<Transaction, "actions"> {
  actions: Action[];
}

const ED25519 = 0;
const FUNCTION_CALL = 2;
/** Borsh enum indices of `Action`. */
const ACTION_INDEX = { CreateAccount: 0, DeployContract: 1, Transfer: 3, AddKey: 5 } as const;

class Writer {
  readonly #bytes: number[] = [];

  u8(v: number): this {
    this.#bytes.push(v & 0xff);
    return this;
  }

  /** Unsigned little-endian integer of `bytes` bytes. */
  uint(v: bigint, bytes: number, name: string): this {
    if (v < 0n || v >= 1n << BigInt(bytes * 8)) throw new Error(`${name} does not fit in u${bytes * 8}`);
    for (let i = 0; i < bytes; i++, v >>= 8n) this.#bytes.push(Number(v & 0xffn));
    return this;
  }

  fixed(b: Uint8Array, length: number, name: string): this {
    if (b.length !== length) throw new Error(`${name} must be ${length} bytes`);
    for (const x of b) this.#bytes.push(x);
    return this;
  }

  /** A `Vec<u8>`: u32 length, then the bytes. */
  vec(b: Uint8Array): this {
    this.uint(BigInt(b.length), 4, "length");
    for (const x of b) this.#bytes.push(x);
    return this;
  }

  string(s: string): this {
    return this.vec(utf8Encode(s));
  }

  done(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

function writeTransaction(w: Writer, tx: AnyTransaction): Writer {
  w.string(tx.signerId).u8(ED25519).fixed(tx.publicKey, 32, "public key");
  w.uint(tx.nonce, 8, "nonce").string(tx.receiverId).fixed(tx.blockHash, 32, "block hash");
  w.uint(BigInt(tx.actions.length), 4, "action count");
  for (const a of tx.actions) {
    if (!("type" in a)) {
      w.u8(FUNCTION_CALL).string(a.methodName).vec(a.args).uint(a.gas, 8, "gas").uint(a.deposit, 16, "deposit");
      continue;
    }
    w.u8(ACTION_INDEX[a.type]);
    if (a.type === "DeployContract") w.vec(a.code);
    else if (a.type === "Transfer") w.uint(a.deposit, 16, "deposit");
    else if (a.type === "AddKey") {
      // PublicKey, then AccessKey { nonce: u64, permission }.
      w.u8(ED25519).fixed(a.publicKey, 32, "public key").uint(0n, 8, "nonce");
      if (a.permission === "FullAccess") w.u8(1);
      else {
        const p = a.permission;
        w.u8(0);
        if (p.allowance === null) w.u8(0);
        else w.u8(1).uint(p.allowance, 16, "allowance");
        w.string(p.receiverId).uint(BigInt(p.methodNames.length), 4, "method count");
        for (const m of p.methodNames) w.string(m);
      }
    }
  }
  return w;
}

export const encodeTransaction = (tx: AnyTransaction): Uint8Array => writeTransaction(new Writer(), tx).done();

export function encodeSignedTransaction(tx: AnyTransaction, signature: Uint8Array): Uint8Array {
  return writeTransaction(new Writer(), tx).u8(ED25519).fixed(signature, 64, "signature").done();
}

/** Signs `sha256(borsh(tx))`, as NEAR does. `hash` is the transaction hash (base58 of it is the tx id). */
export async function signTransaction(
  tx: AnyTransaction,
  key: KeyPair,
): Promise<{ hash: Uint8Array; signature: Uint8Array; signed: Uint8Array }> {
  if (!equalBytes(tx.publicKey, key.publicKey)) throw new Error("transaction public key is not the signer's");
  const hash = sha256(encodeTransaction(tx));
  const signature = await key.sign(hash);
  return { hash, signature, signed: encodeSignedTransaction(tx, signature) };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
