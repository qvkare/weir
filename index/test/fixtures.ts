// Loads the saved real responses as fetch outcomes, so the whole pipeline runs offline.
// `fixtures/*.json`: 2026-11-11 about 19:25 UTC (the H100 first print). `fixtures/v2/*.json`:
// 2026-11-11 about 21:46 UTC, one body per source plus one Vast body per chip.
import { readFileSync } from "node:fs";
import { sha256Hex } from "../src/bundle.ts";
import type { Chip } from "../src/chips.ts";
import type { Outcome } from "../src/method.ts";
import { SOURCES, sourcesFor } from "../src/sources/mod.ts";

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

/** The second day's body for a source (Vast: for a chip). Verda's body was byte-identical to the first day's. */
export function v2Text(sourceId: string, chip?: Chip): string {
  if (sourceId === "verda") return fixtureText("verda");
  return fixtureText(sourceId === "vast" ? `v2/vast-${chip!.id}` : `v2/${sourceId}`);
}

export const v2 = (sourceId: string, chip?: Chip): unknown => JSON.parse(v2Text(sourceId, chip));

/** One chip's outcomes from the second day's bodies; `fail` lists sources to treat as failed fetches. */
export async function v2Outcomes(chip: Chip, fail: readonly string[] = []): Promise<Outcome[]> {
  return Promise.all(sourcesFor(chip).map(async (source): Promise<Outcome> => {
    if (fail.includes(source.id)) return { source, body: null, raw_sha256: await sha256Hex(""), error: "HTTP 503" };
    const body = v2Text(source.id, chip);
    return { source, body, raw_sha256: await sha256Hex(body) };
  }));
}
