// NEAR JSON-RPC: view calls, access keys, account state. Every read tries the RPC URLs of
// deployments.json in order and moves to the next on a network error, a timeout or an RPC
// error that is not the contract's own panic.

export class RpcError extends Error {
  /** True when the contract itself answered with an error (a panic), so failing over is pointless. */
  readonly fromContract: boolean;
  constructor(message: string, fromContract = false) {
    super(message);
    this.fromContract = fromContract;
  }
}

const TIMEOUT_MS = 6000;

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function post(url: string, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new RpcError(`${new URL(url).host} answered HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError(ctrl.signal.aborted ? `${new URL(url).host} did not answer in ${TIMEOUT_MS / 1000} s` : `${new URL(url).host}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Sends one query to the first RPC that answers. */
export async function rpcQuery(rpcs: readonly string[], params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (rpcs.length === 0) throw new RpcError("No RPC URL is configured");
  let last: Error = new RpcError("No RPC answered");
  for (const url of rpcs) {
    try {
      const json = (await post(url, { jsonrpc: "2.0", id: "weir", method: "query", params: { finality: "optimistic", ...params } })) as {
        result?: Record<string, unknown>;
        error?: { message?: string; data?: unknown; cause?: { name?: string } };
      };
      if (json.error) {
        const cause = json.error.cause?.name ?? "";
        const text = typeof json.error.data === "string" ? json.error.data : (json.error.message ?? "RPC error");
        const contract = /CONTRACT_EXECUTION_ERROR|UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|MethodNotFound/i.test(`${cause} ${text}`);
        throw new RpcError(`${cause || "RPC error"}: ${text}`.slice(0, 300), contract);
      }
      const result = json.result ?? {};
      // Old nodes report a contract panic inside a successful response.
      if (typeof result.error === "string") throw new RpcError(String(result.error).slice(0, 300), true);
      return result;
    } catch (e) {
      last = e as Error;
      if (e instanceof RpcError && e.fromContract) throw e;
    }
  }
  throw last;
}

/** A contract view with JSON arguments and a JSON result. */
export async function viewFunction<T>(rpcs: readonly string[], contract: string, method: string, args: object = {}): Promise<T> {
  const result = await rpcQuery(rpcs, { request_type: "call_function", account_id: contract, method_name: method, args_base64: b64(JSON.stringify(args)) });
  const bytes = result.result;
  if (!Array.isArray(bytes)) throw new RpcError(`${method} returned no result`);
  const text = new TextDecoder().decode(Uint8Array.from(bytes as number[]));
  return (text === "" ? null : JSON.parse(text)) as T;
}

export interface AccessKeyInfo {
  publicKey: string;
  permission: "FullAccess" | { receiver: string; methods: string[]; allowance: string | null };
}

export async function accessKeys(rpcs: readonly string[], account: string): Promise<AccessKeyInfo[]> {
  const result = await rpcQuery(rpcs, { request_type: "view_access_key_list", account_id: account });
  const keys = Array.isArray(result.keys) ? (result.keys as { public_key: string; access_key: { permission: unknown } }[]) : [];
  return keys.map((k) => {
    const p = k.access_key?.permission;
    if (p === "FullAccess") return { publicKey: k.public_key, permission: "FullAccess" as const };
    const fc = (p as { FunctionCall?: { receiver_id: string; method_names: string[]; allowance: string | null } })?.FunctionCall;
    return { publicKey: k.public_key, permission: { receiver: fc?.receiver_id ?? "", methods: fc?.method_names ?? [], allowance: fc?.allowance ?? null } };
  });
}

export interface AccountState {
  codeHash: string;
  amount: string;
  storageUsage: number;
}

export async function viewAccount(rpcs: readonly string[], account: string): Promise<AccountState> {
  const r = await rpcQuery(rpcs, { request_type: "view_account", account_id: account });
  return { codeHash: String(r.code_hash ?? ""), amount: String(r.amount ?? "0"), storageUsage: Number(r.storage_usage ?? 0) };
}

/** True when an account has only function-call keys (it cannot attach a deposit). */
export const functionCallOnly = (keys: AccessKeyInfo[]): boolean => keys.length > 0 && keys.every((k) => k.permission !== "FullAccess");
