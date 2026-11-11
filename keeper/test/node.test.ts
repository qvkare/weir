// The Node loop's directory store, under the same ticks as the Worker's KV.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DirStore } from "../src/node.ts";
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
