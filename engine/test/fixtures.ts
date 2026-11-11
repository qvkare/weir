import { commitHash, Market, type Params, type Side } from "../src/mod.ts";

// Series 0 delivers over [100_000, 103_600); its auctions run over [96_400, 100_000) in
// 20 rounds of 180 s: commit for 120 s, reveal for 60 s. With lead = period + cutoff,
// series s + 1 starts its auctions the second series s stops. Prints every 100 s, accepted 120 s late.
export const PARAMS: Params = {
  usdc: "usdc.near",
  underlying: "H100-USD-HR",
  t0: 100_000,
  periodSecs: 3600,
  leadSecs: 3600,
  cutoffSecs: 0,
  commitSecs: 120,
  revealSecs: 60,
  bandBps: 1000,
  tick: 1000,
  printIntervalSecs: 100,
  reportGraceSecs: 120,
  maxSpreadBps: 500,
  minPrints: 3,
  voidAfterSecs: 2400,
  maxAnchorAgeSecs: 1800,
  forfeitBps: 1000,
  minLock: 1000n,
  commitFee: 0n,
  maxCommits: 4,
  maxOrderSize: 100,
  reporters: ["r0", "r1", "r2"],
  quorum: 2,
};

export const BUNDLE = "b".repeat(64);
export const SALT = "5a17".repeat(8);

export interface Secret {
  series: number;
  round: number;
  seq: number;
  owner: string;
  side: Side;
  size: number;
  price: number;
  salt: string;
}

/** Commits a sealed order in the current round and returns what is needed to reveal it. */
export function sealedCommit(
  m: Market,
  owner: string,
  series: number,
  round: number,
  side: Side,
  size: number,
  price: number,
  lock: bigint,
  salt = SALT,
): Secret {
  const hash = commitHash({ series, round, accountId: owner, side, size, price, salt });
  const seq = m.commit(owner, series, hash, lock);
  return { series, round, seq, owner, side, size, price, salt };
}

export function revealSecret(m: Market, s: Secret): void {
  m.reveal(s.owner, s.series, s.round, s.seq, s.side, s.size, s.price, s.salt);
}

/** Has every reporter report `price` for `bucket`, which makes it final at once, at the
 * bucket's start time if the clock allows. */
export function print(m: Market, bucket: number, price: number): void {
  if (m.now < bucket) m.setTime(bucket);
  for (const r of m.params.reporters) m.report(r, bucket, price, BUNDLE);
}
