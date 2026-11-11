// HMAC-SHA-256 against RFC 4231 and against node:crypto.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { hmacHex, hmacSha256, mulberry32, toHex } from "../src/random.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

test("RFC 4231 test cases 1, 2, 4 and 6 (short key, text key, long message, key longer than a block)", () => {
  const cases: [Uint8Array, Uint8Array, string][] = [
    [new Uint8Array(20).fill(0x0b), new TextEncoder().encode("Hi There"), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"],
    [new TextEncoder().encode("Jefe"), new TextEncoder().encode("what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
    [hex("0102030405060708090a0b0c0d0e0f10111213141516171819"), new Uint8Array(50).fill(0xcd), "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"],
    [new Uint8Array(131).fill(0xaa), new TextEncoder().encode("Test Using Larger Than Block-Size Key - Hash Key First"), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
  ];
  for (const [key, msg, want] of cases) assert.equal(toHex(hmacSha256(key, msg)), want);
});

test("hmacHex matches node:crypto on 300 random keys and messages, including non-ASCII", () => {
  const r = mulberry32(5);
  const text = (n: number) => Array.from({ length: n }, () => String.fromCodePoint(r() < 0.9 ? 32 + Math.floor(r() * 95) : 0x400 + Math.floor(r() * 2000))).join("");
  for (let i = 0; i < 300; i++) {
    const key = text(Math.floor(r() * 150));
    const msg = text(Math.floor(r() * 300));
    assert.equal(hmacHex(key, msg), createHmac("sha256", key).update(msg, "utf8").digest("hex"));
  }
});
