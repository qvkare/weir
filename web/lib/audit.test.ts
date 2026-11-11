import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CLOSED, HISTORY, LIMITS } from "./audit.ts";
import { headingId, inline, parseMarkdown } from "./markdown.ts";

const root = new URL("../../", import.meta.url);

test("every finding and limit names a test that exists, and spec sections that exist", () => {
  const dir = new URL("contracts/weir/tests/", root);
  const rs = readdirSync(dir).filter((f) => f.endsWith(".rs")).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  const spec = parseMarkdown(readFileSync(new URL("docs/SPEC.md", root), "utf8"));
  const ids = new Set(spec.filter((b) => b.t === "h").map((b) => (b as { id: string }).id));
  for (const f of [...CLOSED, ...LIMITS]) {
    if (f.test) assert.ok(rs.includes(`fn ${f.test}(`), f.test);
    for (const s of f.sections) assert.ok(ids.has(`s${s.replace(/\./g, "-")}`), `section ${s}`);
  }
  // Every limit_ test in the contract's tests is on the page.
  for (const m of rs.matchAll(/fn (limit_[a-z0-9_]+)\(/g)) assert.ok(LIMITS.some((l) => l.test === m[1]), m[1]);
  assert.ok(LIMITS.some((l) => l.status === "Open") && LIMITS.some((l) => l.status === "Stated"));
  assert.ok(HISTORY.length >= 3);
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
