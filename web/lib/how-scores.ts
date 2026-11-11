// Scores for the five drawings on /how. Each is a short sequence of beats that can be played or
// stepped by hand; the captions carry figures computed by the page (parameters, the engine's
// clearing, the example week's average), passed in here as text.
import { DUR, EASE, draw, enter, fadeIn, grow, growY, pop, track, type Score, type Track } from "./motion.ts";

const BEAT = 1500;
const beats = (labels: string[]) => labels.map((label, i) => ({ at: i * BEAT, label }));
const score = (labels: string[], tracks: Track[]): Score => ({ total: labels.length * BEAT, tracks, beats: beats(labels) });

/** 1. The series clock: auction window, one round, the rest of the rounds and the cutoff, delivery, settlement. */
export function seriesClockScore(t: { lead: string; commit: string; reveal: string; cutoff: string; period: string; grace: string; rounds: number }): Score {
  const tracks: Track[] = [track("auction", grow, 0, DUR.draw, EASE.inOut), track("auction-label", fadeIn, 300)];
  tracks.push(track("r0-commit", grow, BEAT, DUR.base * 2, EASE.linear), track("r0-reveal", grow, BEAT + 640, DUR.base * 2, EASE.linear), track("round-label", fadeIn, BEAT + 200));
  for (let i = 1; i < t.rounds; i++) tracks.push(track(`r${i}`, fadeIn, 2 * BEAT + i * 90, DUR.quick));
  tracks.push(track("cutoff", pop, 2 * BEAT + t.rounds * 90, DUR.base), track("cutoff-label", fadeIn, 2 * BEAT + t.rounds * 90 + 100));
  tracks.push(track("delivery", grow, 3 * BEAT, DUR.draw + 300, EASE.inOut), track("delivery-label", fadeIn, 3 * BEAT + 200), track("prints", fadeIn, 3 * BEAT + 500, DUR.settle));
  tracks.push(track("grace", grow, 4 * BEAT, DUR.base, EASE.linear), track("settle", pop, 4 * BEAT + 380, DUR.base), track("settle-label", fadeIn, 4 * BEAT + 480));
  return score(
    [
      `Auctions for a series open ${t.lead} before its delivery starts.`,
      `Each round is ${t.commit} of commits, then ${t.reveal} of reveals.`,
      `Rounds run back to back until the cutoff, ${t.cutoff} before delivery.`,
      `Delivery lasts ${t.period}. Every index print in it counts toward the average.`,
      `After ${t.grace} for late reports, the series settles on that average.`,
    ],
    tracks,
  );
}

/** 2. Commit and reveal: the order, the hash, what the chain holds, the reveal, the check. */
export function commitScore(): Score {
  return score(
    [
      "Your order: a side, a size in GPU-hours and a LONG price.",
      "Add a secret salt and hash the whole string with sha256.",
      "Commit: only the hash and a lock go on chain. Nobody can read the order.",
      "Reveal: send the order and the salt.",
      "The contract hashes them again. The same hash: the order counts.",
    ],
    [
      track("order", enter, 0),
      track("order-fields", fadeIn, 250, DUR.settle),
      track("preimage", enter, BEAT),
      track("salt", [{ backgroundColor: "var(--flag-soft)" }, { backgroundColor: "transparent" }], BEAT + 300, DUR.settle * 2),
      track("hash", enter, BEAT + 700),
      track("arrow-1", growY, 2 * BEAT, DUR.base, EASE.inOut),
      track("chain", enter, 2 * BEAT + 250),
      track("reveal", enter, 3 * BEAT + 200),
      track("arrow-2", growY, 3 * BEAT, DUR.base, EASE.inOut),
      track("check", pop, 4 * BEAT + 200, DUR.base),
      track("revealed", fadeIn, 4 * BEAT + 450, DUR.base),
    ],
  );
}

/** 3. Clearing three orders. */
export function clearingScore(labels: { price: string; fills: string }): Score {
  return score(
    ["Three revealed orders: A and B buy LONG, C sells SHORT.", "Demand: LONG orders stacked from the highest price down.", "Supply: SHORT orders stacked from the lowest price up.", `The price that trades the most GPU-hours: ${labels.price}.`, labels.fills],
    [
      track("chips", enter, 0),
      track("axes", fadeIn, 0, DUR.settle),
      track("demand", draw, BEAT, DUR.draw + 200, EASE.inOut),
      track("demand-label", fadeIn, BEAT + 500),
      track("supply", draw, 2 * BEAT, DUR.draw + 200, EASE.inOut),
      track("supply-label", fadeIn, 2 * BEAT + 500),
      track("cross", pop, 3 * BEAT, DUR.base),
      track("price", draw, 3 * BEAT + 150, DUR.draw, EASE.inOut),
      track("price-label", fadeIn, 3 * BEAT + 700),
      track("lit", fadeIn, 4 * BEAT, DUR.base),
      track("soft", fadeIn, 4 * BEAT + 100, DUR.settle),
      track("volume", fadeIn, 4 * BEAT + 200),
      track("fills", fadeIn, 4 * BEAT + 300, DUR.base),
    ],
  );
}

/** 4. Settlement against the week's average. `prints` is how many example prints there are. */
export function settlementScore(prints: number, labels: { band: string; fixing: string; long: string; short: string }): Score {
  const tracks: Track[] = [track("band", fadeIn, 0, DUR.settle), track("band-label", fadeIn, 200), track("axes", fadeIn, 0, DUR.settle)];
  for (let i = 0; i < prints; i++) tracks.push(track(`p${i}`, pop, BEAT + i * 160, DUR.base));
  tracks.push(track("average", draw, 2 * BEAT, DUR.draw, EASE.inOut), track("fixing", fadeIn, 2 * BEAT + 700));
  tracks.push(track("pay-long", grow, 3 * BEAT, DUR.settle, EASE.inOut), track("pay-long-label", fadeIn, 3 * BEAT + 400));
  tracks.push(track("pay-short", grow, 4 * BEAT, DUR.settle, EASE.inOut), track("pay-short-label", fadeIn, 4 * BEAT + 400), track("pay-total", fadeIn, 4 * BEAT + 700));
  return score(
    [
      `The band is fixed when the series opens: ${labels.band}.`,
      "Through the delivery week the index prints arrive.",
      `Their average is the fixing: ${labels.fixing}.`,
      `A LONG unit pays the fixing minus the floor: ${labels.long}.`,
      `A SHORT unit pays the rest of the band: ${labels.short}. Together, exactly the band.`,
    ],
    tracks,
  );
}

/** 5. Funding from another chain. */
export function fundingScore(recorded: boolean): Score {
  return score(
    [
      "USDC starts on Base, Arbitrum, Ethereum or Solana.",
      `NEAR Intents: a solver quotes a price and delivers the token.${recorded ? "" : " No transfer is on record yet."}`,
      "The USDC arrives on your NEAR account.",
      "One ft_transfer_call deposits it into your Weir free balance.",
    ],
    [
      track("chains", enter, 0),
      track("link-1", growY, BEAT, DUR.base, EASE.inOut),
      track("intents", enter, BEAT + 250),
      track("link-2", growY, 2 * BEAT, DUR.base, EASE.inOut),
      track("near", enter, 2 * BEAT + 250),
      track("link-3", growY, 3 * BEAT, DUR.base, EASE.inOut),
      track("weir", enter, 3 * BEAT + 250),
    ],
  );
}
