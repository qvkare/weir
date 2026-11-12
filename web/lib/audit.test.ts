import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CLOSED, HISTORY, OPEN, PASSES, SOUND_TESTS, STATED } from "./audit.ts";
import { headingId, inline, parseMarkdown } from "./markdown.ts";

const root = new URL("../../", import.meta.url);

test("every finding and limit names a test that exists, and spec sections that exist", () => {
  const dir = new URL("contracts/weir/tests/", root);
  const rs = readdirSync(dir).filter((f) => f.endsWith(".rs")).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  const spec = parseMarkdown(readFileSync(new URL("docs/SPEC.md", root), "utf8"));
  const ids = new Set(spec.filter((b) => b.t === "h").map((b) => (b as { id: string }).id));
  for (const f of [...CLOSED, ...OPEN, ...STATED]) {
    for (const t of f.tests) assert.ok(rs.includes(`fn ${t}(`), t);
    for (const s of f.sections) assert.ok(ids.has(`s${s.replace(/\./g, "-")}`), `section ${s}`);
  }
  // Every limit_ test in the contract's tests is on the page.
  for (const m of rs.matchAll(/fn ((?:limit|audit[0-9]*)_[a-z0-9_]+)\(/g)) assert.ok([...CLOSED, ...OPEN, ...STATED].some((f) => f.tests.includes(m[1]!)) || SOUND_TESTS.includes(m[1]!), m[1]);
  // Item for item against the record's final table: every numbered finding is on the page.
  const rec = readFileSync(new URL("docs/AUDIT.md", root), "utf8");
  const table = rec.slice(rec.indexOf("## Every finding, status under 0.6"), rec.indexOf("## Examined and found sound"));
  const numbered = [...table.matchAll(/^\| (\d+\.\d+) \|/gm)].map((m) => m[1]!);
  const shown = new Set([...CLOSED, ...OPEN, ...STATED].map((f) => f.id));
  for (const id of numbered) assert.ok(shown.has(id) || id === "1.5", `finding ${id} is not on the page`);
  assert.equal(PASSES, (/in\s+(\w+) passes/.exec(rec)?.[1] === "four" ? 4 : -1));
  assert.equal(HISTORY.length, PASSES);
  // The record the page renders at /audit exists and still says who did it.
  assert.match(readFileSync(new URL("docs/AUDIT.md", root), "utf8"), /not\*\* an audit by a security firm/);
});

test("the spec reader: headings, code, tables, lists and inline marks", () => {
  assert.equal(headingId("9. Index"), "s9");
  assert.equal(headingId("6.2 Commit"), "s6-2");
  const b = parseMarkdown("# T\n\nA `x` and **b** [l](/y).\n\n| a | b |\n|---|---|\n| 1 | `2` |\n\n- one\n  more\n- two\n\n```\ncode\n```\n");
  assert.deepEqual(b.map((x) => x.t), ["h", "p", "table", "ul", "code"]);
  assert.deepEqual(inline("a `c`"), [{ t: "text", v: "a " }, { t: "code", v: "c" }]);
  assert.equal((b[3] as { items: unknown[] }).items.length, 2);
});

test("the record's residual risks are all read, bullet for bullet, for /proof", async () => {
  const { residualRisks } = await import("./audit.ts");
  const rec = readFileSync(new URL("docs/AUDIT.md", root), "utf8");
  const r = residualRisks(rec);
  assert.ok(r, "the section exists");
  const sec = rec.slice(rec.indexOf("## Residual risks before real money"), rec.indexOf("## Verdict"));
  const top = sec.split("\n").filter((l) => /^- /.test(l)).length;
  const nested = sec.split("\n").filter((l) => /^\s{2,}- /.test(l)).length;
  assert.equal(r!.items.length, top);
  assert.equal(r!.items.reduce((n, i) => n + i.children.length, 0), nested);
  const all = JSON.stringify(r);
  // The points the verdict's condition depends on, in the record's figures.
  for (const must of ["one operator", "any price", "0.029 $ a unit", "0.299 $ a unit", "Nothing on chain checks a report", "6.40 $", "guard", "max_round_lock", "off by default", "remove protections", "pruning and sending NEAR", "settlement turns void", "No mainnet history and no upgrade path"]) {
    assert.ok(all.includes(must), must);
  }
});

test("the sandbox comparison's figures are read from integration/RESULTS.md", async () => {
  const { integrationFigures } = await import("./audit.ts");
  const f = integrationFigures(readFileSync(new URL("integration/RESULTS.md", root), "utf8"))!;
  assert.equal(f.run, "Third");
  assert.equal(f.spec, "0.6");
  assert.equal(f.checks, "264 of 264");
  assert.equal(f.stateChanges, "1,315");
  assert.equal(f.views, "2,315");
  assert.equal(f.refusals, "61");
  assert.ok(f.node?.startsWith("near-sandbox"));
});
