// How hard a tick uses the Durable Object's store: the keeper on the model (four markets, three
// chips, eight agents each, three reporters, the housekeeping account) for some hours, with the
// object's SQL store on node:sqlite and the lease off, as in the object. Prints store reads and
// writes per tick (each one SQLite row on Cloudflare, assumed) and what is stored, by prefix.
// The object's own reads and writes (its started mark, its retention mark, `setAlarm`) are not
// included: 2 reads and 2 writes a tick.
//
//   node keeper/scripts/rows.ts [hours, default 3]
import { SqlStore } from "../src/sqlstore.ts";
import type { KeeperStore } from "../src/store.ts";
import { fakeSql } from "../test/fakes.ts";
import { START, world } from "../test/harness.ts";

const hours = Number(process.argv[2] ?? 3);
const w = world();
const store = new SqlStore(fakeSql());
let gets = 0;
let writes = 0;
const counted: KeeperStore = {
  get: (k) => (gets++, store.get(k)),
  put: (k, v) => (writes++, store.put(k, v)),
  delete: (k) => (writes++, store.delete(k)),
};
const perTick: { gets: number; writes: number }[] = [];
for (let t = START; t < START + hours * 3600; t += 60) {
  const [g, p] = [gets, writes];
  await w.at(t, { store: counted, lease: false });
  perTick.push({ gets: gets - g, writes: writes - p });
}
const n = perTick.length;
const byPrefix: Record<string, { keys: number; bytes: number; largest: number }> = {};
for (const s of store.sizes()) {
  const b = (byPrefix[s.key.split("/")[0]!] ??= { keys: 0, bytes: 0, largest: 0 });
  b.keys++;
  b.bytes += s.bytes;
  b.largest = Math.max(b.largest, s.bytes);
}
console.log(`${n} ticks (${hours} h): store reads ${(gets / n).toFixed(1)} a tick (most ${Math.max(...perTick.map((x) => x.gets))}), writes ${(writes / n).toFixed(1)} a tick (most ${Math.max(...perTick.map((x) => x.writes))})`);
console.log(`per day at this rate: ${Math.round((gets / n) * 1440)} reads, ${Math.round((writes / n) * 1440)} writes`);
for (const [prefix, b] of Object.entries(byPrefix)) console.log(`  ${prefix}: ${b.keys} keys, ${b.bytes} characters, largest ${b.largest}`);
