// The hard limit on outbound requests in one tick. Every request the keeper makes (to an
// index source or to a NEAR RPC node) is spent here first; when the limit is reached the
// request is refused before it is made, so a tick can never make one more.

/** What a request was for, in the order the budget is spent. */
export type Priority = "plan" | "urgent-reveal" | "report" | "reveal-clear" | "commit" | "settle-redeem" | "prune";

export const PRIORITY_ORDER: readonly Priority[] = ["plan", "urgent-reveal", "report", "reveal-clear", "commit", "settle-redeem", "prune"];

export const BUDGET_MARK = "request budget used up";

export class BudgetExhausted extends Error {
  override readonly name = "BudgetExhausted";

  constructor(limit: number, what: string) {
    super(`${BUDGET_MARK} (${limit} per tick) before ${what}`);
  }
}

export interface SpentRequest {
  priority: Priority;
  /** The market the request was for; absent for the index fetch, which serves them all. */
  market?: string;
  what: string;
}

export class Budget {
  readonly limit: number;
  /** Every request made, in order. */
  readonly spent: SpentRequest[] = [];
  /** What the requests made now are for. Set by the keeper before each step. */
  priority: Priority = "plan";
  /** The market the requests made now are for. Set by the keeper before each market's turn. */
  market: string | undefined = undefined;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("the request budget must be a positive integer");
    this.limit = limit;
  }

  get used(): number {
    return this.spent.length;
  }

  get left(): number {
    return this.limit - this.spent.length;
  }

  /** Spends `n` requests, or throws without spending any. */
  spend(n: number, what: string): void {
    if (this.spent.length + n > this.limit) throw new BudgetExhausted(this.limit, what);
    for (let i = 0; i < n; i++) this.spent.push({ priority: this.priority, ...(this.market ? { market: this.market } : {}), what });
  }

  /** Throws unless `n` requests are left. Spends nothing. */
  need(n: number, what: string): void {
    if (this.spent.length + n > this.limit) throw new BudgetExhausted(this.limit, what);
  }

  /** A `fetch` that spends one request per call. */
  meter<F extends (url: string, init?: never) => Promise<unknown>>(fetchFn: F): F {
    return (async (url: string, init?: never) => {
      this.spend(1, `request to ${new URL(url).host}`);
      return fetchFn(url, init);
    }) as F;
  }
}
