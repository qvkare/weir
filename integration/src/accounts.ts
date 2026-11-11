// Account setup on the sandbox: create accounts with full or function-call keys, deploy
// contracts. These need actions `ChainWeir` never sends (create account, transfer, add key,
// deploy), encoded by `chain/src/tx.ts`. Every call to Weir and to the token goes through
// `ChainWeir` and `Token`, never through here.
import {
  base58Decode,
  base58Encode,
  KeyPair,
  NearAccount,
  signTransaction,
  utf8Encode,
  type Action,
  type KeyPermission,
  type NearRpc,
  type TxOutcome,
} from "../../chain/src/mod.ts";

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

export async function randomKey(): Promise<{ key: KeyPair; secret: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const secret = `ed25519:${base58Encode(seed)}`;
  return { key: await KeyPair.fromString(secret), secret };
}

/** Signs and sends transactions of any actions for one key, one at a time (own nonce queue). */
export class Signer {
  readonly rpc: NearRpc;
  readonly accountId: string;
  readonly key: KeyPair;
  readonly secret: string;
  #queue: Promise<unknown> = Promise.resolve();
  #nonce = 0n;

  constructor(rpc: NearRpc, accountId: string, key: KeyPair, secret: string) {
    this.rpc = rpc;
    this.accountId = accountId;
    this.key = key;
    this.secret = secret;
  }

  /** A `NearAccount` (the chain client's own signer) over the same key. */
  near(): NearAccount {
    return new NearAccount(this.rpc, this.accountId, this.key);
  }

  send(receiverId: string, actions: Action[]): Promise<TxOutcome> {
    const run = async () => {
      const ak = await this.rpc.viewAccessKey(this.accountId, this.key.publicKeyString);
      const nonce = (BigInt(ak.nonce) > this.#nonce ? BigInt(ak.nonce) : this.#nonce) + 1n;
      this.#nonce = nonce;
      const tx = { signerId: this.accountId, publicKey: this.key.publicKey, nonce, receiverId, blockHash: base58Decode(ak.block_hash), actions };
      const { hash, signed } = await signTransaction(tx, this.key);
      const outcome = await this.rpc.sendTx(signed, base58Encode(hash), this.accountId);
      if (!outcome.ok) throw new Error(`setup transaction to ${receiverId} failed: ${outcome.error}`);
      return outcome;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** A sub-account of this one, funded, with one key: full access, or limited by `permission`. */
  async createAccount(name: string, opts: { balance?: bigint; permission?: KeyPermission; code?: Uint8Array; init?: { method: string; args: object } } = {}): Promise<Signer> {
    const accountId = name.includes(".") ? name : `${name}.${this.accountId}`;
    const { key, secret } = await randomKey();
    const actions: Action[] = [
      { type: "CreateAccount" },
      { type: "Transfer", deposit: opts.balance ?? 50n * NEAR },
      { type: "AddKey", publicKey: key.publicKey, permission: opts.permission ?? "FullAccess" },
    ];
    if (opts.code) actions.push({ type: "DeployContract", code: opts.code });
    if (opts.init) actions.push({ methodName: opts.init.method, args: utf8Encode(JSON.stringify(opts.init.args)), gas: 100n * TGAS, deposit: 0n });
    await this.send(accountId, actions);
    return new Signer(this.rpc, accountId, key, secret);
  }

  /** Adds another key to this account. */
  async addKey(permission: KeyPermission): Promise<Signer> {
    const { key, secret } = await randomKey();
    await this.send(this.accountId, [{ type: "AddKey", publicKey: key.publicKey, permission }]);
    return new Signer(this.rpc, this.accountId, key, secret);
  }
}

export async function signerFromSecret(rpc: NearRpc, accountId: string, secret: string): Promise<Signer> {
  return new Signer(rpc, accountId, await KeyPair.fromString(secret), secret);
}
