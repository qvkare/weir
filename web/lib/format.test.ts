import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtBps, fmtCountdown, fmtDuration, fmtGpuH, fmtPrice, fmtSpan, fmtUsd, fmtUsdExact, fmtUtc, fmtUtcTime, NO_DATA, shortAccount, shortHash, tickDecimals, toBig } from "./format.ts";

test("prices carry their unit and the tick's decimals", () => {
  assert.equal(fmtPrice(2_310_000, 10_000), "$2.31 /GPU-h");
  assert.equal(fmtPrice(2_315_000, 5_000), "$2.315 /GPU-h");
  assert.equal(fmtPrice(620_000), "$0.62 /GPU-h");
  assert.equal(tickDecimals(10_000), 2);
  assert.equal(tickDecimals(1_000), 3);
  assert.equal(tickDecimals(1), 6);
  assert.equal(tickDecimals(1_000_000), 2);
});

test("missing figures print as no data, never zero", () => {
  assert.equal(fmtPrice(null), NO_DATA);
  assert.equal(fmtPrice(undefined), NO_DATA);
  assert.equal(fmtPrice(Number.NaN), NO_DATA);
  assert.equal(fmtUsd(null), NO_DATA);
  assert.equal(fmtUsd("12.5"), NO_DATA);
  assert.equal(fmtGpuH(null), NO_DATA);
  assert.equal(fmtUtc(null), NO_DATA);
  assert.equal(shortHash(""), NO_DATA);
});

test("dollar amounts from micro-USDC strings, to the cent, rounded down", () => {
  assert.equal(fmtUsd("41200000000"), "$41,200.00");
  assert.equal(fmtUsd("1234567"), "$1.23");
  assert.equal(fmtUsd(0n), "$0.00");
  assert.equal(fmtUsd("340282366920938463463374607431768211455"), "$340,282,366,920,938,463,463,374,607,431,768.21");
  assert.equal(fmtUsd(-2_500_000n), "-$2.50");
  assert.equal(toBig("007"), null);
});

test("sizes and shares", () => {
  assert.equal(fmtGpuH(1344), "1,344 GPU-h");
  assert.equal(fmtBps(500), "5%");
  assert.equal(fmtBps(250), "2.5%");
  assert.equal(fmtBps(1500), "15%");
});

test("countdowns never go negative and grow units with length", () => {
  assert.equal(fmtCountdown(252), "04:12");
  assert.equal(fmtCountdown(0), "00:00");
  assert.equal(fmtCountdown(-5), "00:00");
  assert.equal(fmtCountdown(3600 + 252), "1:04:12");
  assert.equal(fmtCountdown(2 * 86_400 + 3 * 3600 + 4 * 60 + 5), "2 d 03:04:05");
  assert.equal(fmtCountdown(59.9), "00:59");
});

test("ages and spans in words", () => {
  assert.equal(fmtDuration(42), "42 s");
  assert.equal(fmtDuration(3 * 3600 + 10 * 60), "3 h 10 m");
  assert.equal(fmtDuration(3 * 3600), "3 h");
  assert.equal(fmtDuration(2 * 86_400 + 4 * 3600), "2 d 4 h");
  assert.equal(fmtSpan(604_800), "7 d");
  assert.equal(fmtSpan(2700), "45 m");
  assert.equal(fmtSpan(90), "90 s");
});

test("times are UTC with the zone written", () => {
  // Mon 17 Nov 2025, 00:00 UTC
  assert.equal(fmtUtc(1_763_337_600), "Mon 17 Nov, 00:00 UTC");
  assert.equal(fmtUtcTime(1_763_337_600 + 14 * 3600 + 2 * 60), "14:02 UTC");
  assert.equal(fmtUtcTime(1_763_337_600 + 9, true), "00:00:09 UTC");
});

test("hashes and accounts shorten in the middle", () => {
  assert.equal(shortHash("9f2c00000000000000a1"), "9f2c…a1");
  assert.equal(shortHash("abc"), "abc");
  assert.equal(shortAccount("short.testnet"), "short.testnet");
  const a = shortAccount("a-very-long-account-name-for-an-agent.testnet", 21);
  assert.equal(a.length, 21);
  assert.ok(a.includes("…"));
});

test("fmtUsdExact: no rounding, at least to the cent", () => {
  assert.equal(fmtUsdExact("29000"), "$0.029");
  assert.equal(fmtUsdExact("2900000"), "$2.90");
  assert.equal(fmtUsdExact("2625000"), "$2.625");
  assert.equal(fmtUsdExact("28250"), "$0.02825");
  assert.equal(fmtUsdExact(1n), "$0.000001");
  assert.equal(fmtUsdExact(0n), "$0.00");
  assert.equal(fmtUsdExact("41200000000"), "$41,200.00");
  assert.equal(fmtUsdExact(-2_500_000n), "-$2.50");
  assert.equal(fmtUsdExact("1.5"), NO_DATA);
});
