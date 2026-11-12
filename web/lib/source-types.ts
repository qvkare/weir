// The one shape every contract read goes through, on the build machine, in the Worker's /api
// routes and in the browser. Browser-safe: no Node, no build data.
import type { ViewMethod, ViewMethods } from "@weir/engine";
import type { Read } from "./cache.ts";
import type { MarketId } from "./config.ts";

export type SourceKind = "chain" | "model" | "none";

export interface Source {
  kind: SourceKind;
  market: MarketId;
  contract: string | null;
  view<M extends ViewMethod>(method: M, args: ViewMethods[M]["args"]): Promise<Read<ViewMethods[M]["result"]>>;
  /** Unix seconds by the source's clock: the model's clock, or this machine's. */
  now(): number;
}

export const NOT_DEPLOYED = "not deployed";

export const isNotDeployed = (r: Read<unknown>): boolean => !r.ok && r.error === NOT_DEPLOYED;

/** A source for a market with no contract: every read says so. */
export function noneSource(market: MarketId): Source {
  return {
    kind: "none",
    market,
    contract: null,
    now: () => Math.floor(Date.now() / 1000),
    async view() {
      return { ok: false, error: NOT_DEPLOYED, lastGood: null };
    },
  };
}
