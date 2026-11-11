// Section 6.2: the commitment a sealed order is bound to.
import { sha256Hex } from "./sha256.ts";

export type Side = "Long" | "Short";

export interface CommitFields {
  series: number;
  round: number;
  accountId: string;
  side: Side;
  size: number;
  price: number;
  salt: string;
}

export function commitPreimage(f: CommitFields): string {
  const side = f.side === "Long" ? "L" : "S";
  return `weir:v1|${f.series}|${f.round}|${f.accountId}|${side}|${f.size}|${f.price}|${f.salt}`;
}

export function commitHash(f: CommitFields): string {
  return sha256Hex(commitPreimage(f));
}

export const isHex64 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

export const isSalt = (s: string): boolean => /^[0-9a-f]{32,64}$/.test(s);
