// From qualifying offers to provider values to the daily composite. Pure functions,
// all in integer micro-USD, so they are tested directly.

import { median } from "@weir/engine";
import { MIN_PROVIDERS, inComposite } from "./providers.ts";

export interface Observation {
  day: string;
  provider: string;
  /** Per-GPU-hour price of each qualifying offer, micro-USD. */
  offers: number[];
  source: string;
  /** Lower wins when two sources cover the same provider on the same day. */
  priority: number;
}

export interface ProviderDay {
  day: string;
  provider: string;
  price: number;
  offers: number;
  source: string;
}

export interface IndexDay {
  day: string;
  /** null when fewer than MIN_PROVIDERS in-composite providers have a value. */
  index: number | null;
  providers: string[];
}

/** One value per provider per day: the median of its offers from the best source. */
export function providerDays(obs: Observation[]): ProviderDay[] {
  const best = new Map<string, Observation>();
  for (const o of obs) {
    if (o.offers.length === 0) continue;
    const key = `${o.day}|${o.provider}`;
    const prev = best.get(key);
    if (!prev || o.priority < prev.priority || (o.priority === prev.priority && o.source < prev.source)) {
      best.set(key, o);
    }
  }
  return [...best.values()]
    .map((o) => ({ day: o.day, provider: o.provider, price: median(o.offers), offers: o.offers.length, source: o.source }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.provider < b.provider ? -1 : 1));
}

/**
 * The composite for each day in `days`: the median of in-composite provider values,
 * or null with fewer than MIN_PROVIDERS. A day without enough data stays null; no
 * value is ever carried forward or interpolated.
 */
export function composite(days: string[], rows: ProviderDay[]): IndexDay[] {
  const byDay = new Map<string, ProviderDay[]>();
  for (const r of rows) {
    if (!inComposite(r.provider)) continue;
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  return days.map((day) => {
    const list = (byDay.get(day) ?? []).sort((a, b) => (a.provider < b.provider ? -1 : 1));
    const providers = list.map((r) => r.provider);
    if (list.length < MIN_PROVIDERS) return { day, index: null, providers };
    return { day, index: median(list.map((r) => r.price)), providers };
  });
}
