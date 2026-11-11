// Everything but the CLI must run in browsers and Cloudflare Workers: no Node imports.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

function files(dir: URL): URL[] {
  return readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    return statSync(url).isDirectory() ? files(new URL(`${name}/`, dir)) : [url];
  });
}

test("no file in src/ except cli.ts imports a Node built-in or uses Node globals", () => {
  for (const url of files(new URL("../src/", import.meta.url))) {
    if (url.pathname.endsWith("/cli.ts")) continue;
    assert.doesNotMatch(readFileSync(url, "utf8"), /from\s+["']node:|require\(|process\.|Buffer\./, url.pathname);
  }
});
