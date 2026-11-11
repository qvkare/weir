// The series strip (DESIGN section 4): one series' life on one time axis. The auction window
// as round blocks (commit solid, reveal hatched), the cutoff, the delivery window, settlement and
// a "now" rule. Horizontal on wide screens; vertical, time running down, on phones.

export interface SeriesTimes {
  series: number;
  auctionOpen: number;
  auctionClose: number;
  deliveryStart: number;
  deliveryEnd: number;
  /** delivery_end + report_grace_secs: the earliest settle. */
  settleAt: number;
  commitSecs: number;
  revealSecs: number;
}

export interface Block {
  round: number;
  /** Position along the time axis, pixels from the axis start. */
  a: number;
  mid: number;
  b: number;
  current: boolean;
}

export interface TimelineGeometry {
  length: number;
  t0: number;
  t1: number;
  blocks: Block[];
  /** True when blocks are thinner than 2 px and are drawn as one band per phase pattern instead. */
  dense: boolean;
  marks: { at: number; pos: number; label: string; kind: "open" | "cutoff" | "delivery" | "end" | "settle" }[];
  delivery: { a: number; b: number };
  auction: { a: number; b: number };
  now: { pos: number; inside: boolean };
}

export function timelineGeometry(s: SeriesTimes, now: number, length: number, currentRound: number | null): TimelineGeometry {
  const pad = (s.settleAt - s.auctionOpen) * 0.02;
  const t0 = Math.min(s.auctionOpen, s.deliveryStart) - pad;
  const t1 = Math.max(s.settleAt, s.auctionClose) + pad;
  const P = (t: number) => ((t - t0) / (t1 - t0)) * length;
  const roundSecs = s.commitSecs + s.revealSecs;
  const count = roundSecs > 0 ? Math.max(0, Math.floor((s.auctionClose - s.auctionOpen) / roundSecs)) : 0;
  const blocks: Block[] = [];
  for (let r = 0; r < count; r++) {
    const start = s.auctionOpen + r * roundSecs;
    blocks.push({ round: r, a: P(start), mid: P(start + s.commitSecs), b: P(start + roundSecs), current: r === currentRound });
  }
  const width = count ? (P(s.auctionOpen + roundSecs) - P(s.auctionOpen)) : 0;
  const marks: TimelineGeometry["marks"] = [
    { at: s.auctionOpen, pos: P(s.auctionOpen), label: "Auctions open", kind: "open" },
    { at: s.auctionClose, pos: P(s.auctionClose), label: "Cutoff", kind: "cutoff" },
    { at: s.deliveryStart, pos: P(s.deliveryStart), label: "Delivery starts", kind: "delivery" },
    { at: s.deliveryEnd, pos: P(s.deliveryEnd), label: "Delivery ends", kind: "end" },
    { at: s.settleAt, pos: P(s.settleAt), label: "Settles from", kind: "settle" },
  ];
  marks.sort((a, b) => a.at - b.at);
  return {
    length,
    t0,
    t1,
    blocks,
    dense: width < 2,
    marks,
    delivery: { a: P(s.deliveryStart), b: P(s.deliveryEnd) },
    auction: { a: P(s.auctionOpen), b: P(s.auctionOpen + count * roundSecs) },
    now: { pos: Math.min(Math.max(P(now), 0), length), inside: now >= t0 && now <= t1 },
  };
}

/** Which stage of its life a series is in at `now`, in words. */
export function seriesStage(s: SeriesTimes, now: number): string {
  if (now < s.auctionOpen) return "Auctions not open yet";
  if (now < s.deliveryStart) return now < s.auctionClose ? "In auction" : "Auctions closed";
  if (now < s.deliveryEnd) return now < s.auctionClose ? "In auction and delivery" : "In delivery";
  if (now < s.settleAt) return "Delivery over, report window open";
  return "Ready to settle";
}
