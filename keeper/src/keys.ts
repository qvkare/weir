// Which account may sign what on which contract. A NEAR function-call key names one receiver
// and a list of methods, so the keeper checks a signer's role list before sending, and treats
// a key the node refused (`KEY_REFUSAL`) as unusable for that contract: logged once, never
// retried in the run, and kept aside for an hour (shown in /status) so it does not cost two
// requests every minute. Fallback ports try the next signer that may make the call.
import { AGENT_KEY_METHODS, CHANGE_METHODS, KEEPER_KEY_METHODS, REPORTER_KEY_METHODS, VIEW_METHODS, type WeirPort } from "@weir/chain";
import { keyRefusal } from "./ports.ts";

export type Role = "keeper" | "agent" | "reporter";

export const ROLE_METHODS: Readonly<Record<Role, readonly string[]>> = {
  keeper: KEEPER_KEY_METHODS,
  agent: AGENT_KEY_METHODS,
  reporter: REPORTER_KEY_METHODS,
};
const LIST_NAME: Readonly<Record<Role, string>> = { keeper: "KEEPER_KEY_METHODS", agent: "AGENT_KEY_METHODS", reporter: "REPORTER_KEY_METHODS" };

/** In every message of a call the keeper did not send for want of a usable key. */
export const NO_KEY_MARK = "no usable key";

export class KeyUnusable extends Error {
  override readonly name = "KeyUnusable";
}

/** How long a refused key is kept aside before it is tried again. */
export const FAULT_SECS = 3600;

export interface KeyFault {
  account: string;
  contract: string;
  /** Null: every method; else only this one (`MethodNameMismatch`). */
  method: string | null;
  reason: string;
  fix: string;
  since: number;
  until: number;
}

const FIX: Record<string, (f: { account: string; contract: string; method: string; role: Role }) => string> = {
  ReceiverMismatch: (f) => `the key names another contract; give ${f.account} a function-call key for ${f.contract} and list it under "keys": { "${f.contract}": ... }`,
  MethodNameMismatch: (f) => `the key on ${f.contract} does not allow ${f.method}; give it the methods of ${LIST_NAME[f.role]}`,
  NotEnoughAllowance: (f) => `the key's allowance on ${f.contract} is spent; add a key with a new allowance for ${f.account}`,
  DepositWithFunctionCall: (f) => `${f.method} attaches a deposit, which a function-call key cannot; use a full-access key for it`,
  AccessKeyNotFound: (f) => `the configured key is not on ${f.account}; add it to the account or fix the secret`,
};

/** Per-run state over the stored faults: what is blocked, and what was already said this run. */
export class KeyGuard {
  readonly faults: Record<string, KeyFault>;
  changed = false;
  readonly #said = new Set<string>();
  readonly #say: (id: string, text: string, market?: string, account?: string) => void;

  constructor(stored: Record<string, KeyFault> | null, now: number, say: (text: string, market?: string, account?: string) => void) {
    this.faults = {};
    for (const [k, f] of Object.entries(stored ?? {})) {
      if (f.until > now) this.faults[k] = f;
      else this.changed = true;
    }
    this.#say = (id, text, market, account) => {
      if (this.#said.has(id)) return;
      this.#said.add(id);
      say(text, market, account);
    };
  }

  blocked(account: string, contract: string, method: string): KeyFault | null {
    return this.faults[`${account}|${contract}|*`] ?? this.faults[`${account}|${contract}|${method}`] ?? null;
  }

  /** Says `text` once per run under `id`. */
  once(id: string, text: string, market?: string, account?: string): void {
    this.#say(id, text, market, account);
  }

  /** A signer, as `role`, on `contract`: calls its role list does not allow, or that a refused
   * key cannot make, are not sent; a refusal by the node because of the key is recorded. */
  guard(port: WeirPort, role: Role, account: string, contract: string, market: string, now: number): WeirPort {
    const change = async (method: string, args: unknown): Promise<unknown> => {
      if (!ROLE_METHODS[role].includes(method)) throw new KeyUnusable(`${NO_KEY_MARK}: ${account} (${role}) may not call ${method}`);
      const f = this.blocked(account, contract, method);
      if (f) throw new KeyUnusable(`${NO_KEY_MARK}: ${account}'s key on ${contract} was refused (${f.reason}) and is set aside until ${f.until}`);
      try {
        return await port.change(method as never, args as never);
      } catch (e) {
        const reason = keyRefusal(e);
        if (reason === null) throw e;
        const method_ = reason === "MethodNameMismatch" ? method : null;
        const fix = (FIX[reason] ?? (() => "check the key"))({ account, contract, method, role });
        this.faults[`${account}|${contract}|${method_ ?? "*"}`] = { account, contract, method: method_, reason, fix, since: now, until: now + FAULT_SECS };
        this.changed = true;
        this.once(`fault|${account}|${contract}|${method_ ?? "*"}`, `${account} cannot ${method} on ${contract}: the node refused its key (${reason}). Fix: ${fix}. Not retried; set aside until ${now + FAULT_SECS}.`, market, account);
        throw new KeyUnusable(`${NO_KEY_MARK}: ${account}'s key on ${contract} was refused (${reason})`);
      }
    };
    return install(port, change);
  }

  /** Changes go to the first signer that may make them; views to `view`. */
  fallback(view: WeirPort, signers: readonly { port: WeirPort; account: string }[], contract: string, market: string): WeirPort {
    const change = async (method: string, args: unknown): Promise<unknown> => {
      const tried: string[] = [];
      for (const s of signers) {
        try {
          return await s.port.change(method as never, args as never);
        } catch (e) {
          if (!(e instanceof KeyUnusable)) throw e;
          tried.push(s.account);
        }
      }
      const who = tried.length > 0 ? `tried ${tried.join(", ")}` : "no signer is configured for it";
      this.once(`none|${contract}|${method}`, `nobody can call ${method} on ${contract}: ${who}. Give the housekeeping account (or, for clear and settle, an agent of this market) a key for ${contract}.`, market);
      throw new KeyUnusable(`${NO_KEY_MARK} for ${method} on ${contract}`);
    };
    return install(view, change);
  }
}

function install(port: WeirPort, change: (m: string, a: unknown) => Promise<unknown>): WeirPort {
  const out: Record<string, unknown> = { accountId: port.accountId, view: (m: string, a: unknown) => port.view(m as never, a as never), change };
  for (const m of VIEW_METHODS) out[m] = (a: unknown) => port.view(m, a as never);
  for (const m of CHANGE_METHODS) out[m] = (a: unknown) => change(m, a);
  return out as unknown as WeirPort;
}
