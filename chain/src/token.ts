// The NEP-141 and NEP-145 calls a Weir user makes on the USDC token: storage registration,
// balance, deposit into Weir with `ft_transfer_call`, and the test token's open `mint`.
import type { U128 } from "@weir/engine";
import type { NearAccount, NearRpc, TxOutcome } from "./near.ts";

const TGAS = 1_000_000_000_000n;
/** 0.00125 NEAR: the usual NEP-145 storage cost of one fungible-token account. Any excess
 * is refunded with `registration_only: true`. */
export const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

export const TOKEN_CALLS = {
  storage_deposit: { gas: 30n * TGAS, deposit: STORAGE_DEPOSIT },
  ft_transfer_call: { gas: 100n * TGAS, deposit: 1n },
  mint: { gas: 30n * TGAS, deposit: 0n },
} as const;

export interface StorageBalance {
  total: U128;
  available: U128;
}

export class Token {
  readonly rpc: NearRpc;
  readonly tokenId: string;

  constructor(rpc: NearRpc, tokenId: string) {
    this.rpc = rpc;
    this.tokenId = tokenId;
  }

  balanceOf(accountId: string): Promise<U128> {
    return this.rpc.view(this.tokenId, "ft_balance_of", { account_id: accountId });
  }

  storageBalanceOf(accountId: string): Promise<StorageBalance | null> {
    return this.rpc.view(this.tokenId, "storage_balance_of", { account_id: accountId });
  }

  /** Registers `accountId` (default: the signer) with the token so it can hold USDC. */
  storageDeposit(signer: NearAccount, accountId = signer.accountId): Promise<TxOutcome> {
    const { gas, deposit } = TOKEN_CALLS.storage_deposit;
    return signer.functionCall(this.tokenId, "storage_deposit", { account_id: accountId, registration_only: true }, gas, deposit);
  }

  /** Deposits `amount` into Weir. Weir credits `beneficiary` if given, else the signer
   * (section 5). The outcome's `result` is the amount Weir kept: all of it, or "0" when the
   * account to credit is not registered with Weir and the token sent it back. */
  depositToWeir(signer: NearAccount, weirId: string, amount: U128, beneficiary?: string): Promise<TxOutcome> {
    const { gas, deposit } = TOKEN_CALLS.ft_transfer_call;
    const args = { receiver_id: weirId, amount, msg: beneficiary ?? "" };
    return signer.functionCall(this.tokenId, "ft_transfer_call", args, gas, deposit);
  }

  /** The test token's open faucet. Not part of NEP-141; a real USDC has no such method. */
  mint(signer: NearAccount, accountId: string, amount: U128): Promise<TxOutcome> {
    const { gas, deposit } = TOKEN_CALLS.mint;
    return signer.functionCall(this.tokenId, "mint", { account_id: accountId, amount }, gas, deposit);
  }
}
