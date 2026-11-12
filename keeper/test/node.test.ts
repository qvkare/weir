// The Node loop's directory store, under the same ticks as the Worker's KV.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DirStore, minuteToRun, nextMinute } from "../src/node.ts";
import { handle } from "../src/routes.ts";
import { KEYS } from "../src/store.ts";
import { START, world } from "./harness.ts";

test("DirStore: one file per key, any key, and the keeper runs on it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weir-keeper-"));
  try {
    const store = new DirStore(dir);
    assert.equal(await store.get("orders/weir|0|1|a.test|0"), null);
    await store.put("orders/weir|0|1|a.test|0", "x");
    assert.equal(await store.get("orders/weir|0|1|a.test|0"), "x");
    await store.delete("orders/weir|0|1|a.test|0");
    await store.delete("never-written");
    assert.equal(await store.get("orders/weir|0|1|a.test|0"), null);

    const w = world({ markets: ["h100-fast"] });
    for (let t = START; t <= START + 300; t += 60) await w.at(t, { store });
    const latest = (JSON.parse((await store.get(KEYS.latest))!) as Record<string, { hash: string }>).h100!;
    const res = await handle(new Request(`http://localhost/bundles/${latest.hash}.json`), store);
    assert.equal(res.status, 200);
    assert.ok(readdirSync(dir).every((f) => !f.endsWith(".tmp")), "no temporary file left behind");
    assert.ok(w.model.market.events.some((e) => e.event === "commit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the loop names the minute it waits for before waiting, so a timer firing early does not run the same minute twice", () => {
  const t = Date.UTC(2026, 10, 12, 1, 8, 0); // 01:08:00 UTC, the start of a tick
  assert.equal(nextMinute(t), t / 1000 + 60);
  assert.equal(nextMinute(t + 40_000), t / 1000 + 60, "after a 40 s tick: 01:09");
  assert.equal(nextMinute(t + 75_000), t / 1000 + 120, "after a 75 s tick: 01:09 is skipped, 01:10 is next");
  // Live on 2026-11-12 the old loop woke at 01:08:59.99x, took floor(now) and ran 01:08 a second time.
  const early = t + 59_999;
  assert.equal(Math.floor(early / 60_000) * 60, t / 1000, "the old rule: 01:08 again");
  assert.equal(minuteToRun(t / 1000 + 60, early), t / 1000 + 60, "the new rule: 01:09");
  // A machine asleep through the wait wakes much later: the tick is for the minute it wakes in.
  assert.equal(minuteToRun(t / 1000 + 60, t + 67 * 60_000 + 500), t / 1000 + 67 * 60);
});
