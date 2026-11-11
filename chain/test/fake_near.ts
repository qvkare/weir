// A fake NEAR RPC endpoint for offline tests. It records every request, checks every
// transaction's signature, and, given a `Market`, executes Weir calls on it the way the
// contract would, so `ChainWeir` can be run against the engine end to end.
import * as ed from "@noble/ed25519";
import { decodeSignedTransaction, Transaction } from "@near-js/transactions";
import { callChange, callView, eventLog, sha256, type Market } from "@weir/engine";
import type { FetchLike } from "../src/near.ts";
import { base58Encode, base64Decode, base64Encode, utf8Decode, utf8Encode } from "../src/tx.ts";

export interface SentCall {
  signer: string;
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
  nonce: bigint;
}

export interface FakeNear {
  fetch: FetchLike;
  requests: { url: string; method: string; params: Record<string, unknown> }[];
  sent: SentCall[];
  /** Override the answer to one request; return undefined to fall through. */
  intercept?: (url: string, method: string, params: Record<string, unknown>) => unknown;
}

export const BLOCK_HASH = base58Encode(new Uint8Array(32).fill(7));

export function fakeNear(opts: { market?: Market; contractId?: string; usdcId?: string } = {}): FakeNear {
  const nonces = new Map<string, bigint>();
  const fake: FakeNear = {
    requests: [],
    sent: [],
    fetch: async (url, init) => {
      const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: Record<string, unknown> };
      fake.requests.push({ url, method, params });
      const reply = (body: unknown) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id, ...body as object }) });
      const custom = fake.intercept?.(url, method, params);
      if (custom !== undefined) return custom as Awaited<ReturnType<FetchLike>>;
      if (method === "query" && params.request_type === "view_access_key") {
        return reply({ result: { nonce: Number(nonces.get(`${params.account_id}`) ?? 0n), permission: "FullAccess", block_hash: BLOCK_HASH, block_height: 1 } });
      }
      if (method === "query" && params.request_type === "call_function") {
        const args = JSON.parse(utf8Decode(base64Decode(params.args_base64 as string)));
        if (!opts.market || params.account_id !== opts.contractId) return reply({ result: { result: [...utf8Encode("null")], logs: [] } });
        try {
          const value = callView(opts.market, params.method_name as never, args as never);
          return reply({ result: { result: [...utf8Encode(JSON.stringify(value))], logs: [], block_height: 1 } });
        } catch (e) {
          return reply({ error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR" }, data: `wasm execution failed: Smart contract panicked: ${(e as Error).message}` } });
        }
      }
      if (method === "block") return reply({ result: { header: { hash: BLOCK_HASH, height: 1 } } });
      if (method === "send_tx") return reply(await execute(fake, opts, nonces, params.signed_tx_base64 as string));
      return reply({ error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND" }, data: method } });
    },
  };
  return fake;
}

async function execute(
  fake: FakeNear,
  opts: { market?: Market; contractId?: string; usdcId?: string },
  nonces: Map<string, bigint>,
  signedBase64: string,
): Promise<unknown> {
  const signed = decodeSignedTransaction(base64Decode(signedBase64));
  const tx = signed.transaction;
  const hash = sha256(new Transaction(tx).encode());
  // Decoded borsh enums come back as plain objects holding number arrays.
  const plain = signed as unknown as { signature: { ed25519Signature: { data: number[] } }; transaction: { publicKey: { ed25519Key: { data: number[] } } } };
  const signature = Uint8Array.from(plain.signature.ed25519Signature.data);
  const publicKey = Uint8Array.from(plain.transaction.publicKey.ed25519Key.data);
  if (!(await ed.verifyAsync(signature, hash, publicKey))) throw new Error("bad signature");
  const last = nonces.get(tx.signerId) ?? 0n;
  if (tx.nonce <= last) {
    const InvalidNonce = { tx_nonce: Number(tx.nonce), ak_nonce: Number(last) };
    return { error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce } } } } };
  }
  nonces.set(tx.signerId, tx.nonce);

  let status: unknown = { SuccessValue: "" };
  const eventsBefore = opts.market?.events.length ?? 0;
  for (const action of tx.actions) {
    const fc = action.functionCall!;
    const args = JSON.parse(utf8Decode(Uint8Array.from(fc.args))) as Record<string, unknown>;
    fake.sent.push({ signer: tx.signerId, receiver: tx.receiverId, method: fc.methodName, args, gas: fc.gas, deposit: fc.deposit, nonce: tx.nonce });
    if (!opts.market) continue;
    try {
      let value: unknown = null;
      if (tx.receiverId === opts.contractId) {
        value = callChange(opts.market, tx.signerId, fc.methodName as never, args as never);
      } else if (tx.receiverId === opts.usdcId && fc.methodName === "ft_transfer_call") {
        const refunded = callChange(opts.market, opts.usdcId, "deposit", { sender_id: tx.signerId, amount: args.amount as string, msg: args.msg as string });
        value = (BigInt(args.amount as string) - BigInt(refunded)).toString();
      }
      status = { SuccessValue: value === null ? "" : base64Encode(utf8Encode(JSON.stringify(value))) };
    } catch (e) {
      status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${(e as Error).message}` } } } } };
    }
  }
  const logs = opts.market ? opts.market.events.slice(eventsBefore).map(eventLog) : [];
  const outcome = { logs, gas_burnt: 2_428_000_000_000, status };
  return { result: {
    final_execution_status: "FINAL",
    status,
    transaction: { hash: base58Encode(hash), signer_id: tx.signerId },
    transaction_outcome: { id: base58Encode(hash), outcome: { ...outcome, logs: [] } },
    receipts_outcome: [{ id: "r1", outcome: { ...outcome, gas_burnt: 1_000_000_000_000 } }],
  } };
}
