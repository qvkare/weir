import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { route, WORKER_FIRST } from "./route.ts";

const at = (p: string) => route(new URL(p, "https://weir.example"));

test("?m=<market> redirects to the market's own page, keeping the other parameters", () => {
  assert.deepEqual(at("/proof?m=h200-weekly"), { kind: "redirect", location: "/m/h200-weekly/proof" });
  assert.deepEqual(at("/?m=a100-80-weekly&range=7d"), { kind: "redirect", location: "/m/a100-80-weekly?range=7d" });
  assert.deepEqual(at("/auction?m=fast&series=7&round=3"), { kind: "redirect", location: "/m/h100-fast/auction?series=7&round=3" });
  assert.deepEqual(at("/auction?m=weekly&series=7"), { kind: "redirect", location: "/auction?series=7" });
  assert.deepEqual(at("/how?m=h100-weekly"), { kind: "redirect", location: "/how" });
  assert.deepEqual(at("/agents?m=nonsense"), { kind: "redirect", location: "/agents" });
});

test("the default market and old names under /m/ go to their addresses; the rest are assets", () => {
  assert.deepEqual(at("/m/h100-weekly/proof"), { kind: "redirect", location: "/proof" });
  assert.deepEqual(at("/m/h100-weekly"), { kind: "redirect", location: "/" });
  assert.deepEqual(at("/m/fast/auction?series=1&round=2"), { kind: "redirect", location: "/m/h100-fast/auction?series=1&round=2" });
  assert.deepEqual(at("/m/weekly/"), { kind: "redirect", location: "/" });
  assert.deepEqual(at("/m/h200-weekly/proof"), { kind: "asset" });
  assert.deepEqual(at("/m/nope/proof"), { kind: "asset" });
  assert.deepEqual(at("/m/h100-weekly/spec"), { kind: "asset" });
  assert.deepEqual(at("/proof"), { kind: "asset" });
  assert.deepEqual(at("/spec?m=h200-weekly"), { kind: "asset" });
  assert.deepEqual(at("/_next/static/chunks/a.js"), { kind: "asset" });
});

test("/api/* is the Worker's", () => {
  assert.deepEqual(at("/api/status?m=h100-fast"), { kind: "api" });
  assert.deepEqual(at("/api/nothing"), { kind: "api" });
});

test("wrangler.jsonc sends exactly WORKER_FIRST to the Worker", () => {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const list = JSON.parse(/"run_worker_first":\s*(\[[^\]]*\])/.exec(text)![1]!) as string[];
  assert.deepEqual(list, WORKER_FIRST);
});
