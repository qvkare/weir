// A Source plus the account-level reads /proof and /agents need (keys, code hash, a token
// balance). Implemented on the server (lib/source.ts) and in the browser (lib/client-source.ts).
import type { Read } from "./cache.ts";
import type { AccessKeyInfo, AccountState } from "./near.ts";
import type { Source } from "./source-types.ts";

export interface Reader {
  src: Source;
  keys(account: string): Promise<Read<AccessKeyInfo[]>>;
  account(account: string): Promise<Read<AccountState>>;
  tokenBalance(token: string, contract: string): Promise<Read<string>>;
}
