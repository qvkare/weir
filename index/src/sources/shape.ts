// Tiny shape guards for parsers: a response that does not look as expected throws,
// and the provider is excluded with the message as its reason.

export type Obj = Record<string, unknown>;

export function obj(x: unknown, what: string): Obj {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error(`${what} is not an object`);
  return x as Obj;
}

export function list(x: unknown, what: string): unknown[] {
  if (!Array.isArray(x)) throw new Error(`${what} is not a list`);
  return x;
}

export function str(x: unknown): string {
  return typeof x === "string" ? x : typeof x === "number" ? String(x) : "";
}

/** A positive count of GPUs, or an error. */
export function gpus(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x <= 0) throw new Error(`${what} has no GPU count`);
  return x;
}
