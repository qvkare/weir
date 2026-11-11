import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex } from "../src/mod.ts";
import { Rng } from "./prng.ts";

const nodeSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("standard SHA-256 vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(sha256Hex("a".repeat(1_000_000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("matches node:crypto on 300 random inputs", () => {
  const rng = new Rng(256);
  // ASCII, two-, three- and four-byte UTF-8, and a lone surrogate.
  const alphabet = ["a", "Z", "0", "|", " ", "é", "ß", "€", "中", "😀", "\ud800"];
  // Lengths around the 55/56/64-byte padding edges come up often.
  const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129];
  for (let i = 0; i < 300; i++) {
    const n = i < lengths.length ? lengths[i]! : rng.chance(0.5) ? rng.int(0, 200) : rng.int(200, 5000);
    let s = "";
    const ascii = rng.chance(0.5);
    for (let j = 0; j < n; j++) s += ascii ? String.fromCharCode(rng.int(32, 126)) : rng.pick(alphabet);
    assert.equal(sha256Hex(s), nodeSha256(s), `input ${i}, ${n} characters`);
  }
});
