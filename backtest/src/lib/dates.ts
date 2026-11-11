// Calendar days as "YYYY-MM-DD" strings, always UTC.

const DAY_MS = 86_400_000;

export function toMs(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`bad date ${day}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromMs(toMs(day) + n * DAY_MS);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

/** Every day from `start` to `end` inclusive. */
export function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 0 = Monday ... 6 = Sunday. */
export function weekday(day: string): number {
  return (new Date(toMs(day)).getUTCDay() + 6) % 7;
}

export function compact(day: string): string {
  return day.replaceAll("-", "");
}
