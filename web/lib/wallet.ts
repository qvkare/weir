// "Connect a NEAR wallet" for the test bid (components/front/app/try-view.tsx). The visitor's own
// testnet account signs the setup once, in their wallet; after that the page trades with a key
// it made itself and keeps in this browser, so the bid, the reveal and the result need no
// wallet prompt.
//
// 1. connect(): makes the trading key, stores it, and asks the wallet to sign in and add that
//    key as a function-call key on the market (NEAR Connect's `addFunctionCallKey`). Then it
//    reads the account and the key from the chain: whether the wallet really added it is not
//    taken on trust.
// 2. setup(): one wallet approval for what is still missing, in order: the key (when the wallet
//    did not add it), the Weir registration, the test dollars. Then the chain is read again.
// 3. The page trades through `Guest.forAccount` with the stored key (lib/try-run.ts).
//
// The wallet library and the chain are passed in (`ConnectorLike`, `ChainReads`), so this file
// is tested in Node against fakes (lib/wallet.test.ts) and holds no network code.
import { depositRefunded } from "@weir/chain/guest";
import { isTradingKey, signInKeyRequest, transferResult, walletSetupBatch, type WalletTx } from "@weir/chain/wallet-setup";
import { readWallet, walletGuestKey, walletKey, type KV, type WalletRecord } from "./try-state.ts";

// ── What this file needs of the wallet library and the chain ─────

/** The part of a NEAR Connect wallet used here. */
export interface WalletLike {
  manifest: { id: string; name: string };
  getAccounts(data?: { network?: string }): Promise<{ accountId: string; publicKey?: string }[]>;
  signAndSendTransactions(p: { transactions: WalletTx[]; network?: "testnet" | "mainnet" }): Promise<unknown>;
}

/** The part of NEAR Connect's `NearConnector` used here. */
export interface ConnectorLike {
  connect(o: { walletId?: string; addFunctionCallKey?: ReturnType<typeof signInKeyRequest> }): Promise<WalletLike>;
  wallet(id?: string | null): Promise<WalletLike>;
  disconnect(wallet?: WalletLike): Promise<void>;
}

/** Chain views (testnet RPC). */
export interface ChainReads {
  accountExists(accountId: string): Promise<boolean>;
  /** The key's permission as `view_access_key` returns it, or null when the key is not on the account. */
  accessKey(accountId: string, publicKey: string): Promise<unknown | null>;
  /** The free balance in the market, micro-USDC, or null when the account is not registered with it. */
  weirBalance(accountId: string): Promise<string | null>;
  /** Test dollars held in the token, micro-USDC. */
  tokenBalance(accountId: string): Promise<string>;
}

export interface WalletDeps {
  contractId: string;
  usdcId: string;
  kv: KV;
  /** Made on first use: the library touches `window` and IndexedDB when created. */
  connector: () => Promise<ConnectorLike>;
  chain: ChainReads;
  /** A new ed25519 key: `ed25519:<base58>` secret and public. */
  newKey: () => Promise<{ secretKey: string; publicKey: string }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

// ── Storage ──────────────────────────────────────────────────────

export { readWallet, walletGuestKey, walletKey, type WalletRecord };

function writeWallet(kv: KV, r: WalletRecord): void {
  try {
    kv.setItem(walletKey(r.contractId), JSON.stringify(r));
  } catch {
    throw new WalletError("storage");
  }
}

// ── Errors in plain words ────────────────────────────────────────

export type WalletErrorKind =
  | "closed"
  | "popup"
  | "no-account"
  | "no-testnet"
  | "key-missing"
  | "refunded"
  | "not-registered"
  | "allowance"
  | "storage"
  | "unknown";

const TEXT: Record<WalletErrorKind, string> = {
  closed: "The wallet window was closed before it finished. Nothing was signed.",
  popup: "The browser blocked the wallet's window. Allow pop-ups for this site, then press the button again.",
  "no-account": "That account does not exist on NEAR testnet. Make a testnet account in your wallet, or switch the wallet to testnet, then connect again.",
  "no-testnet": "This wallet does not work on NEAR testnet. Choose Meteor or Intear, which do.",
  "key-missing": "The wallet did not add the trading key. Press the setup button again: it asks the wallet to add the key in the same approval.",
  refunded: "The test dollars reached the market before the registration did, so the market sent them back to your account. Press “Deposit again” to send them once more.",
  "not-registered": "The registration with the market did not land. Press the setup button again.",
  allowance: "The trading key has used up its gas allowance. Disconnect, then connect again for a new key.",
  storage: "This browser does not let the page keep data, and the trading key has to be kept. Allow site data for this site, then try again.",
  unknown: "The wallet answered with an error. Press the button again; nothing is sent twice.",
};

export class WalletError extends Error {
  override readonly name = "WalletError";
  readonly kind: WalletErrorKind;
  constructor(kind: WalletErrorKind, message: string = TEXT[kind]) {
    super(message);
    this.kind = kind;
  }
}

/** The text of anything a wallet throws: an Error, a string, or an object with a message. */
function rawText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") return (e as { message: string }).message;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** Any failure as a WalletError with plain text. The wallet's own words are never shown. */
export function walletError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const t = rawText(e);
  if (/NotEnoughAllowance/i.test(t)) return new WalletError("allowance");
  if (/pop-?up|window\.open/i.test(t) && /block/i.test(t)) return new WalletError("popup");
  if (/testnet/i.test(t) && /(not|un)\s?support|unavailable|only mainnet/i.test(t)) return new WalletError("no-testnet");
  if (/user rejected|rejected|cancel|denied|wallet closed|closed the|Failed to sign in|No accounts/i.test(t)) return new WalletError("closed");
  return new WalletError("unknown");
}

// ── Amounts ──────────────────────────────────────────────────────

const ONE_USD = 1_000_000n;
/** The deposit a wallet account starts with: 10 test dollars, at least the order's most. */
export const WALLET_DEPOSIT = 10n * ONE_USD;

/** What to deposit to bring `balance` up to what an order may need (or 10 USD), in whole dollars. */
export function depositFor(balance: bigint, maxNeed: bigint | null): bigint {
  const target = maxNeed !== null && maxNeed > WALLET_DEPOSIT ? maxNeed : WALLET_DEPOSIT;
  if (balance >= target) return 0n;
  return ((target - balance + ONE_USD - 1n) / ONE_USD) * ONE_USD;
}

// ── The session ──────────────────────────────────────────────────

export interface WalletStatus {
  accountId: string;
  walletName: string | null;
  keyOnChain: boolean;
  registered: boolean;
  /** Free balance in the market, micro-USDC. */
  balance: bigint;
  /** What the setup would still deposit, micro-USDC (0 when none). */
  deposit: bigint;
  /** Key on chain, registered, funded: the page can bid. */
  ready: boolean;
}

export class WalletSession {
  readonly #d: WalletDeps;
  #walletName: string | null = null;

  constructor(deps: WalletDeps) {
    this.#d = deps;
  }

  get record(): WalletRecord | null {
    return readWallet(this.#d.kv, this.#d.contractId);
  }

  /** The account and the trading key, for `Guest.forAccount`, once connected. */
  get trading(): { accountId: string; secretKey: string } | null {
    const r = this.record;
    return r?.accountId && r.phase !== "connecting" ? { accountId: r.accountId, secretKey: r.secretKey } : null;
  }

  /** Signs in with a wallet the visitor chooses, asking it to add the trading key. The key is
   * stored before the wallet is asked, and kept for a retry. */
  async connect(maxNeed: bigint | null = null): Promise<WalletStatus> {
    const d = this.#d;
    let r = this.record;
    if (r?.accountId && r.phase !== "connecting") return this.check(maxNeed);
    if (!r) {
      const k = await d.newKey();
      r = { version: 1, contractId: d.contractId, secretKey: k.secretKey, publicKey: k.publicKey, walletId: null, accountId: null, phase: "connecting", since: d.now() };
      writeWallet(d.kv, r);
    }
    let wallet: WalletLike;
    let accountId: string | undefined;
    try {
      const connector = await d.connector();
      wallet = await connector.connect({ addFunctionCallKey: signInKeyRequest({ contractId: d.contractId, publicKey: r.publicKey }) });
      accountId = (await wallet.getAccounts({ network: "testnet" }))[0]?.accountId;
    } catch (e) {
      throw walletError(e);
    }
    if (!accountId) throw new WalletError("closed");
    if (!(await d.chain.accountExists(accountId))) {
      void this.#signOut(wallet);
      throw new WalletError("no-account", `${accountId} does not exist on NEAR testnet. ${TEXT["no-account"].replace(/^That account does not exist on NEAR testnet\. /, "")}`);
    }
    this.#walletName = wallet.manifest.name;
    r = { ...r, walletId: wallet.manifest.id, accountId, phase: "connected" };
    writeWallet(d.kv, r);
    return this.check(maxNeed);
  }

  /** What the chain says about the connected account. Views only. */
  async check(maxNeed: bigint | null = null): Promise<WalletStatus> {
    const d = this.#d;
    const r = this.record;
    if (!r?.accountId) throw new Error("no wallet is connected");
    const [key, bal] = await Promise.all([d.chain.accessKey(r.accountId, r.publicKey), d.chain.weirBalance(r.accountId)]);
    const keyOnChain = key !== null && isTradingKey(key, d.contractId);
    const registered = bal !== null;
    const balance = BigInt(bal ?? "0");
    const deposit = depositFor(balance, maxNeed);
    const needed = maxNeed ?? WALLET_DEPOSIT;
    return { accountId: r.accountId, walletName: this.#walletName, keyOnChain, registered, balance, deposit, ready: keyOnChain && registered && balance >= needed };
  }

  /** One wallet approval for what is missing: the key, the registration, the test dollars.
   * Throws a WalletError naming what did not land (`key-missing`, `not-registered`, `refunded`). */
  async setup(maxNeed: bigint | null = null): Promise<WalletStatus> {
    const d = this.#d;
    const before = await this.check(maxNeed);
    if (before.ready) return before;
    const r = this.record!;
    const deposit = before.deposit;
    const held = deposit > 0n ? BigInt(await d.chain.tokenBalance(r.accountId!)) : 0n;
    const mint = deposit > held ? deposit - held : 0n;
    const batch = walletSetupBatch({
      accountId: r.accountId!,
      contractId: d.contractId,
      usdcId: d.usdcId,
      publicKey: r.publicKey,
      deposit: deposit.toString(),
      mint: mint.toString(),
      addKey: !before.keyOnChain,
      register: !before.registered,
    });
    writeWallet(d.kv, { ...r, phase: "setup" });
    let outcomes: unknown;
    try {
      const connector = await d.connector();
      const wallet = await connector.wallet(r.walletId);
      this.#walletName = wallet.manifest.name;
      outcomes = await wallet.signAndSendTransactions({ transactions: batch, network: "testnet" });
    } catch (e) {
      writeWallet(d.kv, { ...r, phase: "connected" });
      throw walletError(e);
    }
    writeWallet(d.kv, { ...r, phase: "connected" });
    // The wallet answers when its transactions are final; views at `final` may trail by a block.
    let after = await this.check(maxNeed);
    for (let i = 0; i < 3 && !after.ready; i++) {
      await d.sleep(2_000);
      after = await this.check(maxNeed);
    }
    if (after.ready) return after;
    if (!after.keyOnChain) throw new WalletError("key-missing");
    if (!after.registered) throw new WalletError("not-registered");
    // Registered, key on chain, balance short: the market sent the deposit back (SPEC section 5).
    // The chain is the record; the wallet's outcome (`ft_transfer_call` kept less) only agrees.
    const kept = Array.isArray(outcomes) ? transferResult(outcomes.at(-1)) : null;
    throw new WalletError(kept !== null && !depositRefunded(kept, deposit.toString()) ? "unknown" : "refunded");
  }

  /** Forgets the trading key and the wallet's account in this browser, and signs the wallet
   * out. The key stays on the account (limited to the market, at most 0.25 NEAR of gas) until
   * the visitor deletes it in the wallet. */
  async disconnect(): Promise<void> {
    const d = this.#d;
    const r = this.record;
    try {
      d.kv.removeItem(walletKey(d.contractId));
      d.kv.removeItem(walletGuestKey(d.contractId));
    } catch {
      // Storage blocked: nothing stored to forget.
    }
    if (r?.walletId) {
      try {
        const c = await d.connector();
        await this.#signOut(await c.wallet(r.walletId), c);
      } catch {
        // Signing out of the wallet is a courtesy; the key is already forgotten here.
      }
    }
  }

  async #signOut(wallet: WalletLike, c?: ConnectorLike): Promise<void> {
    try {
      await (c ?? (await this.#d.connector())).disconnect(wallet);
    } catch {
      // As above.
    }
  }
}
