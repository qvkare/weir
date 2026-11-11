// Loads the saved real responses as fetch outcomes, so the whole pipeline runs offline.
import { readFileSync } from "node:fs";
import { sha256Hex } from "../src/bundle.ts";
import type { Outcome } from "../src/method.ts";
import { SOURCES } from "../src/sources/mod.ts";

export function fixtureText(id: string): string {
  return readFileSync(new URL(`fixtures/${id}.json`, import.meta.url), "utf8");
}

export function fixture(id: string): unknown {
  return JSON.parse(fixtureText(id));
}

export async function fixtureOutcomes(): Promise<Outcome[]> {
  return Promise.all(SOURCES.map(async (source) => {
    const body = fixtureText(source.id);
    return { source, body, raw_sha256: await sha256Hex(body) };
  }));
}
