import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AUDIT_FINDINGS, AUDIT_TEST_FILE } from "./audit.ts";
import { headingId, inline, parseMarkdown } from "./markdown.ts";

const root = new URL("../../", import.meta.url);

test("each audit finding names a test that exists and spec sections that exist", () => {
  const rs = readFileSync(new URL(AUDIT_TEST_FILE, root), "utf8");
  const spec = parseMarkdown(readFileSync(new URL("docs/SPEC.md", root), "utf8"));
  const ids = new Set(spec.filter((b) => b.t === "h").map((b) => (b as { id: string }).id));
  assert.equal(AUDIT_FINDINGS.length, 8);
  for (const f of AUDIT_FINDINGS) {
    assert.ok(rs.includes(`fn ${f.test}(`), f.test);
    for (const s of f.sections) assert.ok(ids.has(`s${s.replace(/\./g, "-")}`), `section ${s}`);
  }
});

test("the spec reader: headings, code, tables, lists and inline marks", () => {
  assert.equal(headingId("9. Index"), "s9");
  assert.equal(headingId("6.2 Commit"), "s6-2");
  const b = parseMarkdown("# T\n\nA `x` and **b** [l](/y).\n\n| a | b |\n|---|---|\n| 1 | `2` |\n\n- one\n  more\n- two\n\n```\ncode\n```\n");
  assert.deepEqual(b.map((x) => x.t), ["h", "p", "table", "ul", "code"]);
  assert.deepEqual(inline("a `c`"), [{ t: "text", v: "a " }, { t: "code", v: "c" }]);
  assert.equal((b[3] as { items: unknown[] }).items.length, 2);
});
