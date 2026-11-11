import assert from "node:assert/strict";
import { test } from "node:test";
import { clearRound } from "@weir/engine";
import { dieLook, layoutDies, lookCounts, rng, WAFER_T, WAFER_TICK, waferBook, waferClock, waferProgress } from "./wafer.ts";
import { Clock } from "./clock.ts";

const g = { cx: 400, cy: 300, r: 260, pitch: 17 };
const dies = layoutDies(g);

test("every die lies inside the wafer's edge, on the pitch", () => {
  assert.ok(dies.length > 600 && dies.length < 1000, `${dies.length} dies`);
  for (const d of dies) {
    for (const [x, y] of [[d.x, d.y], [d.x + g.pitch, d.y], [d.x, d.y + g.pitch], [d.x + g.pitch, d.y + g.pitch]] as const) assert.ok(Math.hypot(x - g.cx, y - g.cy) <= g.r);
    assert.equal(Math.abs(((d.x - g.cx + g.pitch / 2) / g.pitch) % 1), 0);
  }
  assert.equal(layoutDies(g, { w: 400, h: 600 }).every((d) => d.x <= 400), true);
});

test("the generator is seeded: one seed, one book", () => {
  const a = rng(7);
  const b = rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.deepEqual(waferBook(dies, 42).fill, waferBook(dies, 42).fill);
  assert.notDeepEqual(waferBook(dies, 42).fill, waferBook(dies, 43).fill);
});

test("the book is the engine's clearing, one order per die, laid out with every order once", () => {
  for (const seed of [1, 2, 3, 99]) {
    const book = waferBook(dies, seed, 2_760_000);
    assert.equal(book.orders.length, dies.length);
    assert.equal(new Set(book.orders.map((o) => o.seq)).size, dies.length);
    // Re-clear the same orders in seq order: the same price, volume and fills.
    const bySeq = [...book.orders].sort((a, b) => a.seq - b.seq);
    const again = clearRound(bySeq, WAFER_TICK);
    assert.equal(book.clearing.price, again.price);
    assert.equal(book.clearing.volume, again.volume);
    book.orders.forEach((o, k) => assert.equal(book.fill[k], again.fills[o.seq]));
    // It trades near the anchor, and both sides fill the same volume.
    assert.ok(book.clearing.price !== null && Math.abs(book.clearing.price - 2_760_000) < 400_000);
    const sum = (side: string) => book.orders.reduce((s, o, k) => s + (o.side === side ? book.fill[k]! : 0), 0);
    assert.equal(sum("Long"), book.clearing.volume);
    assert.equal(sum("Short"), book.clearing.volume);
    for (const o of book.orders) assert.equal(o.price % WAFER_TICK, 0);
  }
});

test("the keenest orders sit nearest the centre, so filled dies cluster there", () => {
  const book = waferBook(dies, 5);
  const filled = dies.filter((_, k) => book.fill[k]! > 0);
  const out = dies.filter((_, k) => book.fill[k] === 0);
  const mean = (xs: typeof dies) => xs.reduce((s, d) => s + d.d, 0) / xs.length;
  assert.ok(mean(filled) < mean(out));
});

test("the round reads in order: sealed, probed open, then cleared from the centre", () => {
  const book = waferBook(dies, 11);
  const at = (t: number) => lookCounts(t, dies, g, book);
  assert.equal(at(0).sealed, dies.length);
  assert.equal(at(WAFER_T.probeStart - 0.01).sealed, dies.length);
  const mid = at((WAFER_T.probeStart + WAFER_T.probeEnd) / 2);
  assert.ok(mid.sealed > 0 && mid.open > 0 && mid.filled + mid.part + mid.out === 0);
  const open = at(WAFER_T.clearStart - 0.01);
  assert.equal(open.open, dies.length);
  const still = at(WAFER_T.still);
  assert.equal(still.sealed + still.open, 0);
  assert.equal(still.filled + still.part, book.filledCount);
  // The probe only moves down; the ring only grows.
  let y = -Infinity;
  let r = 0;
  for (let t = 0; t <= WAFER_T.total; t += 0.1) {
    const p = waferProgress(t, g);
    assert.ok(p.probeY >= y);
    assert.ok(p.ring >= r);
    y = p.probeY;
    r = p.ring;
  }
  // The round ends as it began: every die sealed, so the hand-over to the next book is seamless.
  assert.equal(at(WAFER_T.total).sealed, dies.length);
  assert.equal(at(WAFER_T.total - 0.001).sealed, dies.length);
});

test("a part-filled die looks part-filled once cleared", () => {
  const book = waferBook(dies, 3);
  const k = book.fill.findIndex((f, i) => f > 0 && f < book.orders[i]!.size);
  if (k < 0) return; // no partial fill in this book
  assert.equal(dieLook(WAFER_T.still, dies[k]!, g.pitch, book.fill[k]!, book.orders[k]!.size, waferProgress(WAFER_T.still, g)), "part");
});

test("the wafer is time-based: any frame times reach the same round and moment, and a pause does not jump", () => {
  const book = waferBook(dies, 11);
  for (const seed of [1, 2, 3]) {
    const r = rng(seed);
    const clock = new Clock();
    let now = 1000;
    clock.start(now);
    // Uneven frames from 4 ms to 600 ms (a throttled background tab), with one long pause.
    while (clock.elapsed(now) < 2 * WAFER_T.total * 1000 + WAFER_T.still * 1000) {
      now += 4 + r() * 596;
      if (Math.abs(now - 9000) < 300 && clock.running) {
        clock.pause(now);
        now += 20_000;
        const before = clock.elapsed(now);
        clock.start(now);
        assert.equal(clock.elapsed(now), before);
      }
    }
    const { round, t } = waferClock(clock.elapsed(now));
    assert.equal(round, 2);
    assert.ok(t >= WAFER_T.still && t < WAFER_T.still + 0.6);
  }
  // Exactly at the stated time the round is over and every die is sealed again.
  const end = waferClock(WAFER_T.total * 1000);
  assert.deepEqual(end, { round: 1, t: 0 });
  assert.equal(lookCounts(end.t, dies, g, book).sealed, dies.length);
  assert.equal(lookCounts(WAFER_T.still, dies, g, book).filled + lookCounts(WAFER_T.still, dies, g, book).part, book.filledCount);
});
