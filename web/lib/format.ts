// Every figure on the site is formatted here. Prices are micro-USD per GPU-hour (numbers),
// dollar amounts are micro-USDC (bigint or decimal strings), times are Unix seconds, UTC.
// Missing values print as "no data", never as 0.

export const NO_DATA = "no data";

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Decimal places needed to show a price on the tick, at least 2 (cents). */
export function tickDecimals(tick: number | undefined): number {
  if (!tick || !Number.isFinite(tick) || tick <= 0) return 2;
  let d = 0;
  while (d < 6 && (tick / 10 ** (6 - d)) % 1 !== 0) d++;
  // tick / 10^(6-d) is whole once d covers the tick's last significant micro digit.
  return Math.max(2, d);
}

function fixed(value: number, decimals: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** A price in micro-USD per GPU-hour as dollars: "$2.31". */
export function dollarsOfPrice(micro: number | null | undefined, tick?: number): string {
  if (micro === null || micro === undefined || !Number.isFinite(micro)) return NO_DATA;
  const sign = micro < 0 ? "-" : "";
  return `${sign}$${fixed(Math.abs(micro) / 1e6, tickDecimals(tick))}`;
}

/** A price with its unit: "$2.31 /GPU-h". */
export function fmtPrice(micro: number | null | undefined, tick?: number): string {
  const d = dollarsOfPrice(micro, tick);
  return d === NO_DATA ? d : `${d} /GPU-h`;
}

/** Parses a u128 decimal string or bigint; null when it is not one. */
export function toBig(v: bigint | string | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : null;
  return /^-?(0|[1-9][0-9]*)$/.test(v) ? BigInt(v) : null;
}

/** micro-USDC as dollars to the cent, rounded down: "$41,200.00". */
export function fmtUsd(v: bigint | string | number | null | undefined): string {
  const b = toBig(v);
  if (b === null) return NO_DATA;
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const cents = abs / 10_000n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${whole.toLocaleString("en-US")}.${frac}`;
}

/** micro-USDC as dollars with no rounding, at least to the cent: "$2.90", "$0.029", "$2.625".
 * For the test bid's lock, fee, forfeit and balance, where a cent rounded down misstates a
 * small amount (1% of $2.90 is $0.029, not $0.02). */
export function fmtUsdExact(v: bigint | string | number | null | undefined): string {
  const b = toBig(v);
  if (b === null) return NO_DATA;
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${neg ? "-" : ""}$${(abs / 1_000_000n).toLocaleString("en-US")}.${frac}`;
}

/** micro-USDC as the test bid shows an amount: under $0.10 to three decimals ("$0.028"),
 * otherwise to the nearest cent ("$2.79"); both rounded half up. Never four decimals. */
export function fmtUsdShort(v: bigint | string | number | null | undefined): string {
  const b = toBig(v);
  if (b === null) return NO_DATA;
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const mills = (abs + 500n) / 1_000n;
  let text: string;
  if (abs === 0n) {
    text = "0.00";
  } else if (mills < 100n) {
    text = `0.${mills.toString().padStart(3, "0")}`;
  } else {
    const cents = (abs + 5_000n) / 10_000n;
    text = `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
  }
  return `${neg && abs > 0n ? "-" : ""}$${text}`;
}

/** As fmtUsd, but an exact zero reads "none", so a real zero is never mistaken for a placeholder. */
export function fmtUsdOrNone(v: bigint | string | number | null | undefined): string {
  const b = toBig(v);
  return b === 0n ? "none" : fmtUsd(v);
}

/** micro-USDC as a float of dollars, for chart positions only. */
export function usdNumber(v: bigint | string | number | null | undefined): number | null {
  const b = toBig(v);
  return b === null ? null : Number(b) / 1e6;
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NO_DATA;
  return grouped.format(n);
}

/** Whole GPU-hours: "1,344 GPU-h". */
export function fmtGpuH(n: number | null | undefined): string {
  const s = fmtInt(n);
  return s === NO_DATA ? s : `${s} GPU-h`;
}

/** Basis points as a percentage: 500 -> "5%", 250 -> "2.5%". */
export function fmtBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return NO_DATA;
  return `${Number((bps / 100).toFixed(2))}%`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A countdown: "04:12" under an hour, "1:04:12" under a day, "2 d 03:04:12" beyond. Never negative. */
export function fmtCountdown(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return `${d} d ${pad2(h)}:${pad2(m)}:${pad2(r)}`;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(r)}`;
  return `${pad2(m)}:${pad2(r)}`;
}

/** An age or duration in words: "42 s", "5 m", "3 h 10 m", "2 d 4 h". */
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m`;
  if (s < 86_400) {
    const m = Math.floor((s % 3600) / 60);
    return m ? `${Math.floor(s / 3600)} h ${m} m` : `${Math.floor(s / 3600)} h`;
  }
  const h = Math.floor((s % 86_400) / 3600);
  return h ? `${Math.floor(s / 86_400)} d ${h} h` : `${Math.floor(s / 86_400)} d`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 17 Nov, 00:00 UTC". */
export function fmtUtc(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return NO_DATA;
  const d = new Date(ts * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** "14:02 UTC", or "14:02:09 UTC" with seconds. */
export function fmtUtcTime(ts: number | null | undefined, seconds = false): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return NO_DATA;
  const d = new Date(ts * 1000);
  const base = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return `${seconds ? `${base}:${pad2(d.getUTCSeconds())}` : base} UTC`;
}

/** "17 Nov 2026". */
export function fmtUtcDate(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return NO_DATA;
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "9f2c…a1": the first four and last two characters. */
export function shortHash(h: string | null | undefined, head = 4, tail = 2): string {
  if (!h) return NO_DATA;
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Long NEAR account ids shortened in the middle for narrow cells. */
export function shortAccount(a: string, max = 22): string {
  if (a.length <= max) return a;
  const keep = max - 1;
  return `${a.slice(0, Math.ceil(keep / 2))}…${a.slice(-Math.floor(keep / 2))}`;
}

/** Seconds as a plain length for parameter tables: "5 m", "1 h", "7 d". */
export function fmtSpan(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return NO_DATA;
  if (secs % 86_400 === 0 && secs >= 86_400) return `${secs / 86_400} d`;
  if (secs % 3600 === 0 && secs >= 3600) return `${secs / 3600} h`;
  if (secs % 60 === 0 && secs >= 60) return `${secs / 60} m`;
  return `${fmtInt(secs)} s`;
}
