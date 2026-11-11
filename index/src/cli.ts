// node index/src/cli.ts fetch [--chip h100|h200|a100-80|all] [--bucket <ts>] [--interval 3600] [--out evidence/bundles] [--no-raw]
// node index/src/cli.ts verify <file> [--raw <dir>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { bundleHash, canonical, verifyBundle, verifyRaw, type Check } from "./bundle.ts";
import { CHIP_IDS, CHIPS, chipById, type Chip } from "./chips.ts";
import { fetchChips, type FetchFn } from "./fetch.ts";
import { makeBundle, METHOD_V1, usd, type Bundle } from "./method.ts";

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
}

function table(b: Bundle): string {
  const rows = b.providers.map((p) => [
    p.id,
    p.kind,
    p.value === undefined ? "-" : usd(p.value),
    String(p.offers.length) + (p.dropped ? ` (+${p.dropped.length} dropped)` : ""),
    p.status === "included" ? "included" : `excluded: ${p.reason}`,
  ]);
  const all = [["provider", "kind", "value", "offers", "status"], ...rows];
  const w = all[0]!.map((_, c) => Math.max(...all.map((r) => r[c]!.length)));
  return all.map((r) => r.map((s, c) => (c === 4 ? s : s.padEnd(w[c]!))).join("  ")).join("\n");
}

async function fetchCmd(args: string[]): Promise<number> {
  const interval = Number(flag(args, "--interval", "3600"));
  const start = Math.floor(Date.now() / 1000);
  const bucket = Number(flag(args, "--bucket", String(start - (start % interval))));
  if (!Number.isSafeInteger(interval) || interval <= 0 || !Number.isSafeInteger(bucket) || bucket % interval !== 0) {
    console.error(`bucket ${bucket} is not a multiple of interval ${interval}`);
    return 2;
  }
  const chipArg = flag(args, "--chip", "h100");
  const chips: Chip[] = chipArg === "all" ? CHIP_IDS.map((id) => CHIPS[id]) : [chipById(chipArg)].filter((c) => c !== undefined);
  if (chips.length === 0) {
    console.error(`unknown chip ${chipArg}; one of ${CHIP_IDS.join(", ")}, all`);
    return 2;
  }
  const out = flag(args, "--out", "evidence/bundles");
  const sent: string[] = [];
  const counting: FetchFn = (url, init) => (sent.push(`${init.method ?? "GET"} ${url}`), fetch(url, init));
  const runs = await fetchChips(chips, { fetch: counting });
  const raws = new Map<string, Uint8Array>();
  for (const { chip, outcomes } of runs) {
    const bundle = makeBundle(bucket, Math.floor(Date.now() / 1000), outcomes, chip);
    const hash = await bundleHash(bundle);
    const dir = `${out}/${chip.id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${bucket}-${hash.slice(0, 12)}.json`, canonical(bundle));
    for (const f of outcomes) if (f.bytes) raws.set(f.raw_sha256, f.bytes);
    console.log(`== ${chip.index_name} (${chip.name})\n${table(bundle)}`);
    console.log(`\nindex ${bundle.index === null ? `none: ${bundle.reason}` : `${usd(bundle.index)} USD (${bundle.index} micro-USD)`}`);
    console.log(`bucket ${bucket}  bundle ${hash}\nwrote ${dir}/${bucket}-${hash.slice(0, 12)}.json\n`);
  }
  if (!args.includes("--no-raw")) {
    // Raw bodies are stored once by content, however many chips or buckets share them.
    mkdirSync(`${out}/raw`, { recursive: true });
    for (const [sha, bytes] of raws) if (!existsSync(`${out}/raw/${sha}.json`)) writeFileSync(`${out}/raw/${sha}.json`, bytes);
    console.log(`raw bodies: ${raws.size} in ${out}/raw/`);
  }
  console.log(`HTTP requests: ${sent.length} for ${chips.length} chip(s)`);
  return 0;
}

/** Where a bundle's raw bodies live: `<name>.raw/<source>.json` (version 1) or `<out>/raw/<sha256>.json` (version 2). */
function rawBodies(file: string, bundle: Bundle, rawFlag: string): { dir: string; bodies: [string, string][] } {
  if (bundle.method === METHOD_V1) {
    const dir = file.replace(/\.json$/, ".raw");
    return { dir, bodies: existsSync(dir) ? readdirSync(dir).sort().map((f) => [f.replace(/\.json$/, ""), `${dir}/${f}`]) : [] };
  }
  const dir = rawFlag || `${file.replace(/\/?[^/]*$/, "") || "."}/../raw`;
  const bySource = new Map(bundle.providers.map((p) => [p.source, p.raw_sha256]));
  const bodies: [string, string][] = [];
  for (const [source, sha] of [...bySource].sort()) if (existsSync(`${dir}/${sha}.json`)) bodies.push([source, `${dir}/${sha}.json`]);
  return { dir, bodies };
}

async function verifyCmd(args: string[]): Promise<number> {
  const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--raw");
  if (!file) {
    console.error("usage: cli.ts verify <bundle.json> [--raw <dir>]");
    return 2;
  }
  const text = readFileSync(file, "utf8");
  const bundle = JSON.parse(text) as Bundle;
  const hash = await bundleHash(bundle);
  const checks: Check[] = verifyBundle(bundle);
  checks.push({ name: "file is in canonical form", ok: text === canonical(bundle), expected: true, actual: text === canonical(bundle) });
  const named = /(?:^|\/)(\d+)-([0-9a-f]{12})\.json$/.exec(file);
  if (named) {
    const expected = `${bundle.bucket}-${hash.slice(0, 12)}`;
    checks.push({ name: "file name is <bucket>-<hash prefix>", ok: `${named[1]}-${named[2]}` === expected, expected, actual: `${named[1]}-${named[2]}` });
  }
  const parent = /([^/]+)\/[^/]+$/.exec(file)?.[1];
  if (bundle.chip !== undefined && parent !== undefined && chipById(parent)) {
    checks.push({ name: "directory is the bundle's chip", ok: parent === bundle.chip, expected: bundle.chip, actual: parent });
  }
  const raw = rawBodies(file, bundle, flag(args, "--raw", ""));
  const sources = new Set(bundle.providers.filter((p) => !p.reason?.startsWith("fetch failed: ")).map((p) => p.source));
  for (const [source, path] of raw.bodies) checks.push(...(await verifyRaw(bundle, source, readFileSync(path))));
  for (const c of checks) {
    const detail = c.ok ? "" : `  expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`;
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  const missing = sources.size - raw.bodies.length;
  console.log(`\nbundle ${hash}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed${missing > 0 ? ` (${missing} of ${sources.size} raw bodies not found in ${raw.dir}; their offers not re-derived)` : ""}`);
  return failed === 0 ? 0 : 1;
}

const [cmd, ...rest] = process.argv.slice(2);
const code = cmd === "fetch" ? await fetchCmd(rest) : cmd === "verify" ? await verifyCmd(rest) : (console.error("usage: cli.ts fetch|verify ..."), 2);
process.exitCode = code;
