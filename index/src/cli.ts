// node index/src/cli.ts fetch [--bucket <ts>] [--interval 3600] [--out evidence/bundles] [--no-raw]
// node index/src/cli.ts verify <file>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { bundleHash, canonical, verifyBundle, verifyRaw, type Check } from "./bundle.ts";
import { fetchAll } from "./fetch.ts";
import { makeBundle, usd, type Bundle } from "./method.ts";
import { SOURCES } from "./sources/mod.ts";

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
}

function table(b: Bundle): string {
  const rows = b.providers.map((p) => [
    p.id,
    p.kind,
    p.value === undefined ? "-" : usd(p.value),
    String(p.offers.length),
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
  const out = flag(args, "--out", "evidence/bundles");
  const fetched = await fetchAll(SOURCES);
  const bundle = makeBundle(bucket, Math.floor(Date.now() / 1000), fetched);
  const hash = await bundleHash(bundle);
  const name = `${bucket}-${hash.slice(0, 12)}`;
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/${name}.json`, canonical(bundle));
  if (!args.includes("--no-raw")) {
    mkdirSync(`${out}/${name}.raw`, { recursive: true });
    for (const f of fetched) if (f.bytes) writeFileSync(`${out}/${name}.raw/${f.source.id}.json`, f.bytes);
  }
  console.log(table(bundle));
  console.log(`\nindex ${bundle.index === null ? `none: ${bundle.reason}` : `${usd(bundle.index)} USD (${bundle.index} micro-USD)`}`);
  console.log(`bucket ${bucket}  bundle ${hash}\nwrote ${out}/${name}.json`);
  return 0;
}

async function verifyCmd(args: string[]): Promise<number> {
  const file = args[0];
  if (!file) {
    console.error("usage: cli.ts verify <bundle.json>");
    return 2;
  }
  const text = readFileSync(file, "utf8");
  const bundle = JSON.parse(text) as Bundle;
  const hash = await bundleHash(bundle);
  const checks: Check[] = verifyBundle(bundle);
  checks.push({ name: "file is in canonical form", ok: text === canonical(bundle), expected: true, actual: text === canonical(bundle) });
  const named = /(\d+)-([0-9a-f]{12})\.json$/.exec(file);
  if (named) {
    const expected = `${bundle.bucket}-${hash.slice(0, 12)}`;
    checks.push({ name: "file name is <bucket>-<hash prefix>", ok: `${named[1]}-${named[2]}` === expected, expected, actual: `${named[1]}-${named[2]}` });
  }
  const rawDir = file.replace(/\.json$/, ".raw");
  if (existsSync(rawDir)) {
    for (const f of readdirSync(rawDir).sort()) {
      checks.push(...(await verifyRaw(bundle, f.replace(/\.json$/, ""), readFileSync(`${rawDir}/${f}`))));
    }
  }
  for (const c of checks) {
    const detail = c.ok ? "" : `  expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`;
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\nbundle ${hash}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed${existsSync(rawDir) ? "" : " (no raw bodies found; offers not re-derived)"}`);
  return failed === 0 ? 0 : 1;
}

const [cmd, ...rest] = process.argv.slice(2);
const code = cmd === "fetch" ? await fetchCmd(rest) : cmd === "verify" ? await verifyCmd(rest) : (console.error("usage: cli.ts fetch|verify ..."), 2);
process.exitCode = code;
