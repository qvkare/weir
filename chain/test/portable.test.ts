// Everything but the CLI must run in browsers and Cloudflare Workers: no Node imports.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("no file in src/ except cli.ts imports a Node built-in", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (name === "cli.ts") continue;
    const text = readFileSync(new URL(name, dir), "utf8");
    assert.doesNotMatch(text, /from\s+["']node:|require\(|process\.|Buffer\./, name);
  }
});
