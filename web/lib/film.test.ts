import assert from "node:assert/strict";
import { test } from "node:test";
import { clearRound } from "@weir/engine";
import { buildFilm, FILM_BEATS, FILM_ORDERS, FILM_TICK } from "./film.ts";
import { dollarsOfPrice } from "./format.ts";
import { beatAt, beatEnd, checkScore } from "./motion.ts";

const film = buildFilm();

test("the film's picture is the engine's clearing", () => {
  const c = clearRound(FILM_ORDERS, FILM_TICK);
  assert.equal(film.price, c.price);
  assert.equal(film.volume, c.volume);
  film.tickets.forEach((t, i) => assert.equal(t.filled, c.fills[i]));
  const side = (s: "Long" | "Short") => film.tickets.filter((t) => t.side === s).reduce((a, t) => a + t.filled, 0);
  assert.equal(side("Long"), film.volume);
  assert.equal(side("Short"), film.volume);
});

test("the example shows every kind of outcome: full, part and out", () => {
  const states = new Set(film.tickets.map((t) => t.state));
  assert.deepEqual([...states].sort(), ["full", "out", "part"]);
  for (const t of film.tickets) assert.match(t.hash, /^[0-9a-f]{64}$/);
  assert.equal(new Set(film.tickets.map((t) => t.hash)).size, film.tickets.length);
});

test("the score is sound and tells the mechanism in under ten seconds", () => {
  assert.deepEqual(checkScore(film.score), []);
  assert.ok(film.score.total < 10_000);
  assert.equal(film.score.beats.length, 7);
});

test("the order of events follows the rules: sealed, revealed, curves, cross, price, fills", () => {
  const start = (t: string) => film.score.tracks.find((x) => x.target === t)!.start;
  const end = (t: string) => {
    const x = film.score.tracks.find((y) => y.target === t)!;
    return x.start + x.duration;
  };
  const n = film.tickets.length;
  for (let i = 0; i < n; i++) {
    assert.ok(end(`t-${i}`) <= FILM_BEATS.reveal, `bid ${i} arrives before any reveal`);
    assert.ok(end(`open-${i}`) <= start("demand"), `bid ${i} is revealed before the curves draw`);
    assert.ok(start(`fill-${i}`) >= start("price"), `bid ${i} lights up after the price is set`);
  }
  assert.ok(end("demand") <= start("price") + 1 && start("cross") < start("price"));
  // Only orders left out are dimmed.
  const dimmed = film.score.tracks.filter((t) => t.target.startsWith("dim-")).map((t) => Number(t.target.slice(4)));
  assert.deepEqual(dimmed, film.tickets.flatMap((t, i) => (t.state === "out" ? [i] : [])));
});

test("beats: the one showing at a time, and where each ends", () => {
  assert.equal(beatAt(film.score, 0), 0);
  assert.equal(beatAt(film.score, FILM_BEATS.cross + 1), 3);
  assert.equal(beatAt(film.score, film.score.total), film.score.beats.length - 1);
  assert.equal(beatEnd(film.score, 0), FILM_BEATS.reveal);
  assert.equal(beatEnd(film.score, film.score.beats.length - 1), film.score.total);
});

test("the captions carry the engine's figures", () => {
  assert.ok(film.summary.includes(dollarsOfPrice(film.price, FILM_TICK)));
  assert.ok(film.summary.includes(dollarsOfPrice(film.band - film.price, FILM_TICK)));
  assert.match(film.score.beats[5]!.label, /G in part, 5 of 25/);
});

test("checkScore catches a track that overruns and beats out of order", () => {
  const bad = checkScore({ total: 100, tracks: [{ target: "x", keyframes: [{}, {}], start: 50, duration: 80 }], beats: [{ at: 10, label: "" }, { at: 5, label: "" }] });
  assert.equal(bad.length, 3);
});
