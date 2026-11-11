// A fake NEAR network for the offline tests: accounts, access keys with NEAR's permission
// rules, balances, and just enough of the two contracts (the token's storage, mint and
// ft_transfer_call into Weir; Weir's new, register, set_guard, ft_on_transfer, get_params and
// get_account) to execute every transaction `apply` sends. It can be told to "die" around the
// n-th transaction, as a killed process would.
import { createHash } from "node:crypto";
import { base58Encode, utf8Decode, type AccessKeyPermission, type AccountInfo, type KeyPair } from "../../chain/src/mod.ts";
import type { WireAccount, WireParams } from "../../engine/src/mod.ts";
import type { DeployAction, DeployChain, KeyView, Sent, SignerKey } from "../src/chain.ts";
import { NO_CODE } from "../src/chain.ts";
import type { Wasm } from "../src/wasm.ts";

export class Killed extends Error {}

interface Acct {
  amount: bigint;
  code: string;
  keys: Map<string, AccessKeyPermission>;
  storage: number;
}

export const fakeWasm = (name: Wasm["name"], fill: number): Wasm => {
  const bytes = new Uint8Array(1000).fill(fill);
  const d = createHash("sha256").update(bytes).digest();
  return { name, path: `/fake/${name}.wasm`, bytes, size: bytes.length, sha256: d.toString("hex"), codeHash: base58Encode(new Uint8Array(d)) };
};

export class FakeChain implements DeployChain {
  readonly accounts = new Map<string, Acct>();
  readonly weir = new Map<string, { params: WireParams; accounts: Map<string, WireAccount> }>();
  readonly token = new Map<string, Map<string, bigint>>();
  readonly sends: { signer: string; receiver: string; kinds: string[] }[] = [];
  clock = 1_794_470_400;
  grant = 10n * 10n ** 24n;
  /** Throw `Killed` before applying the n-th transaction (1-based) of this chain's life... */
  dieBefore: number | null = null;
  /** ...or after applying it, before its result is returned. */
  dieAfter: number | null = null;
  #txs = 0;
  readonly wasm: { weir: Wasm; usdc: Wasm };

  constructor(wasm: { weir: Wasm; usdc: Wasm }) {
    this.wasm = wasm;
  }

  async now() {
    return this.clock;
  }
  async gasPrice() {
    return 100_000_000n;
  }
  costs = { version: 88, gasPrice: 100_000_000n, gasPurchasePrice: 1_000_000_000n, accountCreationCharge: 7n * 10n ** 21n, storagePerByte: 10n ** 19n };
  async protocol() {
    return this.costs;
  }
  async account(id: string): Promise<AccountInfo | null> {
    const a = this.accounts.get(id);
    return a ? { amount: a.amount.toString(), locked: "0", code_hash: a.code, storage_usage: a.storage } : null;
  }
  async keys(id: string): Promise<KeyView[]> {
    const a = this.accounts.get(id);
    return a ? [...a.keys].map(([public_key, permission]) => ({ public_key, nonce: 1, permission })) : [];
  }

  async view<T>(contract: string, method: string, args: Record<string, unknown>): Promise<T> {
    const w = this.weir.get(contract);
    const t = this.token.get(contract);
    if (w && method === "get_params") return structuredClone(w.params) as T;
    if (w && method === "get_account") return (w.accounts.get(String(args.account_id)) ?? null) as T;
    if (t && method === "storage_balance_of") return (t.has(String(args.account_id)) ? { total: "1250000000000000000000", available: "0" } : null) as T;
    if (t && method === "ft_balance_of") return (t.get(String(args.account_id)) ?? 0n).toString() as T;
    throw new Error(`fake: no view ${method} on ${contract}`);
  }

  async createTopLevel(accountId: string, key: KeyPair) {
    if (this.accounts.has(accountId)) throw new Error("exists");
    this.#tick();
    this.accounts.set(accountId, { amount: this.grant, code: NO_CODE, keys: new Map([[key.publicKeyString, "FullAccess"]]), storage: 200 });
    const hash = this.#done();
    return { hash, note: "fake faucet" };
  }

  #tick(): void {
    this.#txs++;
    if (this.dieBefore === this.#txs) throw new Killed(`killed before transaction ${this.#txs}`);
  }

  #done(): string {
    if (this.dieAfter === this.#txs) throw new Killed(`killed after transaction ${this.#txs}`);
    return `faketx${this.#txs}`;
  }

  async send(signer: SignerKey, receiver: string, actions: DeployAction[]): Promise<Sent> {
    this.#tick();
    const s = this.accounts.get(signer.accountId);
    const perm = s?.keys.get(signer.key.publicKeyString);
    if (!s || !perm) throw new Error(`fake: ${signer.accountId} has no such key`);
    if (perm !== "FullAccess") {
      const p = perm.FunctionCall;
      for (const a of actions) {
        if ("type" in a || p.receiver_id !== receiver || !p.method_names.includes(a.methodName) || a.deposit !== 0n) throw new Error("fake: function-call key may not do this");
      }
    } else if (receiver !== signer.accountId && actions.some((a) => "type" in a && a.type !== "CreateAccount" && a.type !== "Transfer" && a.type !== "AddKey")) {
      throw new Error("fake: setup actions on another account");
    }
    this.sends.push({ signer: signer.accountId, receiver, kinds: actions.map((a) => ("type" in a ? a.type : a.methodName)) });
    let result: unknown = null;
    for (const a of actions) {
      if ("type" in a) {
        if (a.type === "CreateAccount") {
          if (this.accounts.has(receiver) || !receiver.endsWith(`.${signer.accountId}`)) throw new Error("fake: cannot create");
          this.accounts.set(receiver, { amount: 0n, code: NO_CODE, keys: new Map(), storage: 200 });
        } else if (a.type === "Transfer") {
          if (s.amount < a.deposit) throw new Error("fake: not enough balance");
          s.amount -= a.deposit;
          this.accounts.get(receiver)!.amount += a.deposit;
        } else if (a.type === "AddKey") {
          const pk = `ed25519:${base58Encode(a.publicKey)}`;
          const p = a.permission;
          this.accounts.get(receiver)!.keys.set(pk, p === "FullAccess" ? "FullAccess" : { FunctionCall: { receiver_id: p.receiverId, method_names: [...p.methodNames], allowance: p.allowance === null ? null : p.allowance.toString() } });
        } else if (a.type === "DeleteKey") {
          this.accounts.get(receiver)!.keys.delete(`ed25519:${base58Encode(a.publicKey)}`);
        } else if (a.type === "DeployContract") {
          const hash = base58Encode(new Uint8Array(createHash("sha256").update(a.code).digest()));
          this.accounts.get(receiver)!.code = hash;
          if (hash === this.wasm.usdc.codeHash) this.token.set(receiver, new Map());
        }
        continue;
      }
      const args = JSON.parse(utf8Decode(a.args)) as Record<string, unknown>;
      if (a.deposit > s.amount) throw new Error("fake: deposit over balance");
      s.amount -= a.deposit;
      result = this.#call(signer.accountId, receiver, a.methodName, args, a.deposit);
    }
    const hash = this.#done();
    return { hash, ok: true, error: null, result, gas_burnt: 1 };
  }

  #call(from: string, to: string, method: string, args: Record<string, unknown>, deposit: bigint): unknown {
    const t = this.token.get(to);
    if (method === "new") {
      if (this.accounts.get(to)!.code !== this.wasm.weir.codeHash || this.weir.has(to)) throw new Error("fake: bad new");
      this.weir.set(to, { params: (args as { params: WireParams }).params, accounts: new Map() });
      return null;
    }
    const w = this.weir.get(to);
    if (w && method === "register") {
      const id = String(args.account_id ?? from);
      if (w.accounts.has(id) || deposit < 20n * 10n ** 21n) throw new Error("fake: register");
      w.accounts.set(id, { balance: "0", guard: null, max_round_lock: null });
      return null;
    }
    if (w && method === "set_guard") {
      if (deposit !== 1n) throw new Error("fake: one yocto");
      const acc = w.accounts.get(from)!;
      acc.guard = args.guard as number;
      acc.max_round_lock = args.max_round_lock as string;
      return null;
    }
    if (t && method === "storage_deposit") {
      t.set(String(args.account_id), t.get(String(args.account_id)) ?? 0n);
      return null;
    }
    if (t && method === "mint") {
      const id = String(args.account_id);
      t.set(id, (t.get(id) ?? 0n) + BigInt(String(args.amount)));
      return null;
    }
    if (t && method === "ft_transfer_call") {
      const amount = BigInt(String(args.amount));
      const bal = t.get(from) ?? 0n;
      if (bal < amount || deposit !== 1n) throw new Error("fake: transfer");
      const target = this.weir.get(String(args.receiver_id));
      const acc = target?.accounts.get(from);
      if (!acc) return "0";
      t.set(from, bal - amount);
      t.set(String(args.receiver_id), (t.get(String(args.receiver_id)) ?? 0n) + amount);
      acc.balance = (BigInt(acc.balance) + amount).toString();
      return amount.toString();
    }
    throw new Error(`fake: no method ${method} on ${to}`);
  }

  get txCount(): number {
    return this.#txs;
  }

  /** Everything that matters, comparable between two runs (key bytes differ, so keys are counted). */
  snapshot(): unknown {
    return {
      accounts: [...this.accounts].map(([id, a]) => [id, a.code, [...a.keys.values()].map((p) => JSON.stringify(p)).sort()]).sort(),
      weir: [...this.weir].map(([id, w]) => [id, { ...w.params, t0: 0 }, [...w.accounts].sort()]).sort(),
      token: [...this.token].map(([id, t]) => [id, [...t].map(([k, v]) => [k, v.toString()]).sort()]),
    };
  }
}
