// Reads backtest/results/site.json and summary.json (produced by the backtest package) into the
// rows the /backtest page draws. Nothing is filled in: a week without a figure is dropped and
// counted, and a file that cannot be read is reported as missing.

export interface BacktestWeek {
  /** Delivery week start, Unix seconds UTC. */
  start: number;
  label: string;
  /** All prices in USD per GPU-hour. */
  anchor: number | null;
  fixing: number;
  floor: number;
  cap: number;
  hedged: number;
  unhedged: number;
  /** LONG price used for the week, when the file gives it. */
  p: number | null;
  inside: boolean;
}

export interface Backtest {
  weeks: BacktestWeek[];
  dropped: number;
  summary: Record<string, unknown> | null;
  meta: Record<string, unknown>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** The files may give USD or micro-USD; a price above 1,000 per GPU-hour can only be micro-USD. */
const usd = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n > 1000 ? n / 1e6 : n;
};

function weekStart(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n > 1e12 ? Math.floor(n / 1000) : n;
  if (typeof v === "string") {
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  return null;
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** site.json may be columnar: `weeks` a list of dates and every other field a list of the same length. */
function rowsOfColumns(o: Record<string, unknown>): Record<string, unknown>[] | null {
  const weeks = o.weeks;
  if (!Array.isArray(weeks) || weeks.length === 0 || weeks.some((w) => typeof w !== "string" && typeof w !== "number")) return null;
  const cols = Object.entries(o).filter(([k, v]) => k !== "weeks" && Array.isArray(v) && v.length === weeks.length) as [string, unknown[]][];
  return weeks.map((w, i) => Object.fromEntries([["week", w], ...cols.map(([k, v]) => [k, v[i]])]));
}

export function readBacktest(site: unknown, summary: unknown): Backtest | null {
  if (site === null || site === undefined) return null;
  const meta: Record<string, unknown> = site && typeof site === "object" && !Array.isArray(site) ? { ...(site as Record<string, unknown>) } : {};
  const columns = Array.isArray(site) ? null : rowsOfColumns(meta);
  const list: unknown[] = Array.isArray(site) ? site : (columns ?? (["weeks", "rows", "series", "data"].map((k) => meta[k]).find(Array.isArray) as unknown[] | undefined) ?? []);
  for (const k of ["weeks", "rows", "series", "data"]) delete meta[k];
  if (columns) for (const [k, v] of Object.entries(meta)) if (Array.isArray(v)) delete meta[k];
  const weeks: BacktestWeek[] = [];
  let dropped = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") {
      dropped++;
      continue;
    }
    const o = item as Record<string, unknown>;
    const start = weekStart(pick(o, ["start", "week_start", "delivery_start", "week", "delivery_week", "date"]));
    const fixing = usd(pick(o, ["fixing", "average", "avg", "realized"]));
    const floor = usd(pick(o, ["floor"]));
    const band = usd(pick(o, ["band"]));
    const cap = usd(pick(o, ["cap", "ceiling"])) ?? (floor !== null && band !== null ? floor + band : null);
    const hedged = usd(pick(o, ["hedged", "hedged_price", "effective", "hedged_cost"]));
    const unhedged = usd(pick(o, ["unhedged", "unhedged_price", "unhedged_cost"])) ?? fixing;
    if (start === null || fixing === null || floor === null || cap === null || hedged === null || unhedged === null) {
      dropped++;
      continue;
    }
    const insideRaw = pick(o, ["inside", "inside_band", "in_band", "covered"]);
    const inside = typeof insideRaw === "boolean" ? insideRaw : fixing >= floor && fixing <= cap;
    const label = typeof o.label === "string" ? o.label : typeof o.week === "string" ? o.week : new Date(start * 1000).toISOString().slice(0, 10);
    weeks.push({ start, label, anchor: usd(pick(o, ["anchor"])), fixing, floor, cap, hedged, unhedged, p: usd(pick(o, ["p", "long_price", "clearing", "price"])), inside });
  }
  weeks.sort((a, b) => a.start - b.start);
  return { weeks, dropped, summary: summary && typeof summary === "object" && !Array.isArray(summary) ? (summary as Record<string, unknown>) : null, meta };
}

export interface Coverage {
  weeks: number;
  inside: number;
  outside: number;
  /** Sum over weeks of (hedged - unhedged) per GPU-hour, USD: negative means hedging lowered the bill. */
  totalDiff: number;
  meanAbsDiff: number;
  largestSaving: BacktestWeek | null;
  largestCost: BacktestWeek | null;
}

export function coverage(weeks: BacktestWeek[]): Coverage {
  let totalDiff = 0;
  let abs = 0;
  let largestSaving: BacktestWeek | null = null;
  let largestCost: BacktestWeek | null = null;
  for (const w of weeks) {
    const d = w.hedged - w.unhedged;
    totalDiff += d;
    abs += Math.abs(d);
    if (d < 0 && (!largestSaving || d < largestSaving.hedged - largestSaving.unhedged)) largestSaving = w;
    if (d > 0 && (!largestCost || d > largestCost.hedged - largestCost.unhedged)) largestCost = w;
  }
  const inside = weeks.filter((w) => w.inside).length;
  return { weeks: weeks.length, inside, outside: weeks.length - inside, totalDiff, meanAbsDiff: weeks.length ? abs / weeks.length : 0, largestSaving, largestCost };
}

export interface BacktestGeometry {
  width: number;
  height: number;
  plot: { x0: number; x1: number; y0: number; y1: number };
  yTicks: { y: number; label: string }[];
  weeks: {
    week: BacktestWeek;
    x: number;
    w: number;
    band: { y0: number; y1: number };
    unhedgedY: number;
    hedgedY: number;
  }[];
  xLabels: { x: number; label: string }[];
}

/** Places each week on the chart: band rectangle, unhedged dot, hedged tick. */
export function backtestGeometry(weeks: BacktestWeek[], width: number, height: number): BacktestGeometry {
  const narrow = width < 560;
  const plot = { x0: narrow ? 44 : 56, x1: width - 12, y0: 12, y1: height - 40 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const w of weeks) {
    lo = Math.min(lo, w.floor, w.unhedged, w.hedged);
    hi = Math.max(hi, w.cap, w.unhedged, w.hedged);
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  const pad = (hi - lo || 1) * 0.1;
  lo = Math.max(0, lo - pad);
  hi = hi + pad;
  const step = niceStep((hi - lo) / 5);
  const ys = (v: number) => plot.y1 - ((v - lo) / (hi - lo)) * (plot.y1 - plot.y0);
  const yTicks: { y: number; label: string }[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) yTicks.push({ y: ys(v), label: `$${v.toFixed(2)}` });
  const n = Math.max(1, weeks.length);
  const slot = (plot.x1 - plot.x0) / n;
  const w = Math.max(1, slot * 0.72);
  const every = Math.max(1, Math.ceil(n / Math.floor((plot.x1 - plot.x0) / (narrow ? 64 : 84))));
  return {
    width,
    height,
    plot,
    yTicks,
    weeks: weeks.map((week, i) => ({
      week,
      x: plot.x0 + slot * i + (slot - w) / 2,
      w,
      band: { y0: ys(week.cap), y1: ys(week.floor) },
      unhedgedY: ys(week.unhedged),
      hedgedY: ys(week.hedged),
    })),
    xLabels: weeks
      .map((week, i) => ({ i, week }))
      .filter(({ i }) => i % every === 0)
      .map(({ i, week }) => ({ x: plot.x0 + slot * i + slot / 2, label: shortDate(week.start) })),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
};

/** 1, 2 or 5 times a power of ten, at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** The bullets under "## What this does not show" in summary.md: "- **Title.** Text". */
export function caveatsFromMarkdown(md: string | null): { title: string; text: string }[] {
  if (!md) return [];
  const start = md.search(/^## What this does not show/m);
  if (start < 0) return [];
  const rest = md.slice(start).split("\n").slice(1);
  const out: { title: string; text: string }[] = [];
  for (const line of rest) {
    if (/^## /.test(line)) break;
    const m = /^- \*\*(.+?)\*\*\s*(.*)$/.exec(line.trim());
    if (m) out.push({ title: m[1]!.replace(/\.$/, ""), text: m[2]!.replace(/`/g, "") });
  }
  return out;
}
