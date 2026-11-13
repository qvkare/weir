// What a NEAR wallet signs for the test bid, as plain data in the action shape of NEAR Connect
// (`@hot-labs/near-connect`, `ConnectorAction`): `{ type, params }` objects with amounts as
// decimal strings. Pure builders, no network: web/lib/wallet.ts hands them to the wallet.
//
// The wallet signs only the setup: the Weir registration, the test dollars, and (when the
// wallet did not add it at sign-in) the trading key. The page then trades with that key, a
// function-call key on the market limited to AGENT_KEY_METHODS: it can commit, reveal, clear,
// mint, merge, settle and redeem, and cannot withdraw or move tokens (SPEC section 15).
import { setupTransactions, type SetupTx } from "./guest.ts";
import { base64Decode } from "./tx.ts";
import { AGENT_KEY_METHODS } from "./weir.ts";

/** The trading key's lifetime gas allowance: 0.25 NEAR (NEAR Connect's default). A commit and
 * a reveal cost about 0.0008 NEAR of it; a `clear` needs 0.155 NEAR left (CLEAR_ALLOWANCE). */
export const TRADING_KEY_ALLOWANCE = 250_000_000_000_000_000_000_000n;

/** The methods the trading key may call on the market. */
export const TRADING_KEY_METHODS: readonly string[] = AGENT_KEY_METHODS;

export interface WalletFunctionCall {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
}

export interface WalletAddKey {
  type: "AddKey";
  params: {
    publicKey: string;
    accessKey: { permission: { receiverId: string; allowance: string; methodNames: string[] } };
  };
}

export interface WalletDeleteKey {
  type: "DeleteKey";
  params: { publicKey: string };
}

export type WalletAction = WalletFunctionCall | WalletAddKey | WalletDeleteKey;

/** One transaction for `signAndSendTransactions`. */
export interface WalletTx {
  receiverId: string;
  actions: WalletAction[];
}

/** The `addFunctionCallKey` option of `connect()`: the page's public key on the market. */
export function signInKeyRequest(o: { contractId: string; publicKey: string; allowance?: bigint }): {
  contractId: string;
  publicKey: string;
  allowMethods: { anyMethod: false; methodNames: string[] };
  gasAllowance: { kind: "limited"; amount: string };
} {
  return {
    contractId: o.contractId,
    publicKey: o.publicKey,
    allowMethods: { anyMethod: false, methodNames: [...TRADING_KEY_METHODS] },
    gasAllowance: { kind: "limited", amount: (o.allowance ?? TRADING_KEY_ALLOWANCE).toString() },
  };
}

/** `setupTransactions` in the wallet's action shape. */
export function toWalletTxs(txs: readonly SetupTx[]): WalletTx[] {
  return txs.map((tx) => ({
    receiverId: tx.receiverId,
    actions: tx.calls.map((c) => ({
      type: "FunctionCall" as const,
      params: { methodName: c.methodName, args: c.args, gas: c.gas.toString(), deposit: c.deposit.toString() },
    })),
  }));
}

/** The fallback when the wallet did not add the trading key at sign-in: one transaction from
 * the visitor's account to itself, adding a function-call key on the market. */
export function addKeyTx(o: { accountId: string; contractId: string; publicKey: string; allowance?: bigint }): WalletTx {
  return {
    receiverId: o.accountId,
    actions: [
      {
        type: "AddKey",
        params: {
          publicKey: o.publicKey,
          accessKey: { permission: { receiverId: o.contractId, allowance: (o.allowance ?? TRADING_KEY_ALLOWANCE).toString(), methodNames: [...TRADING_KEY_METHODS] } },
        },
      },
    ],
  };
}

/** Removes the trading key from the account (optional, on disconnect). */
export function deleteKeyTx(o: { accountId: string; publicKey: string }): WalletTx {
  return { receiverId: o.accountId, actions: [{ type: "DeleteKey", params: { publicKey: o.publicKey } }] };
}

/** The whole batch for the one setup approval, in the order it is sent: the key (when missing),
 * the Weir registration (when not registered), then the token transaction (storage_deposit,
 * mint, ft_transfer_call) when a deposit is due. A wallet may not keep the order: a deposit
 * that reaches Weir before the registration is sent back (SPEC section 5; `depositRefunded`). */
export function walletSetupBatch(o: {
  accountId: string;
  contractId: string;
  usdcId: string;
  publicKey: string;
  /** micro-USDC to deposit; "0" for none. */
  deposit: string;
  /** micro-USDC to mint first; defaults to `deposit`. */
  mint?: string;
  addKey: boolean;
  register: boolean;
}): WalletTx[] {
  const out: WalletTx[] = [];
  if (o.addKey) out.push(addKeyTx(o));
  const setup = setupTransactions({ contractId: o.contractId, usdcId: o.usdcId, accountId: o.accountId, deposit: o.deposit, mint: o.mint, register: o.register });
  for (const tx of toWalletTxs(setup)) {
    if (tx.receiverId === o.usdcId && BigInt(o.deposit) === 0n) continue;
    out.push(tx);
  }
  return out;
}

/** Whether an access key read with `view_access_key` is the trading key: a function-call key on
 * the market whose methods include commit and reveal. */
export function isTradingKey(permission: unknown, contractId: string): boolean {
  if (!permission || typeof permission !== "object" || !("FunctionCall" in permission)) return false;
  const fc = (permission as { FunctionCall: { receiver_id?: string; method_names?: string[] } }).FunctionCall;
  if (fc.receiver_id !== contractId) return false;
  const names = fc.method_names ?? [];
  return names.length === 0 || (names.includes("commit") && names.includes("reveal"));
}

/** What `ft_transfer_call` returned in a wallet's outcome for the token transaction (the amount
 * Weir kept, as a JSON string), or null when the outcome does not say. Reads NEAR's
 * `FinalExecutionOutcome`: `status.SuccessValue`, base64 of the JSON result. */
export function transferResult(outcome: unknown): string | null {
  const status = (outcome as { status?: { SuccessValue?: unknown } } | null)?.status;
  const v = status && typeof status === "object" ? status.SuccessValue : undefined;
  if (typeof v !== "string") return null;
  try {
    const text = new TextDecoder().decode(base64Decode(v));
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}
