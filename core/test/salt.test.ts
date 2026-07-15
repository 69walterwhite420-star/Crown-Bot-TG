// The salt vectors: a byte copy of crown-factory's fixtures, themselves
// cross-checked against python hashlib and fuzz-verified against the
// deployed program. Every vector must pass; the copy's byte identity with
// the factory original is a separate CI lint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fromHex, hex } from "../src/bytes.ts";
import { streamSalt } from "../src/salt.ts";

interface Vector {
  donor_hex: string;
  recipients_hex: string[];
  shares: number[];
  chunk: string;
  n_chunks: string;
  t0: string;
  period: string;
  resolver_hex: string;
  fee_bps: number;
  fee_wallet_hex: string;
  nonce: string;
  salt_hex: string;
}

// JSON numbers lose precision past 2^53; the vectors carry full u64/i64
// values, so numeric fields are quoted before parsing.
function loadVectors(): Vector[] {
  const url = new URL("../vectors/stream-salt.json", import.meta.url);
  const quoted = readFileSync(url, "utf8").replace(
    /"(chunk|n_chunks|t0|period|nonce)": (-?\d+)/g,
    '"$1": "$2"',
  );
  return JSON.parse(quoted) as Vector[];
}

test("every factory salt vector passes", () => {
  const vectors = loadVectors();
  assert.ok(vectors.length >= 4, "vectors present");
  for (const vector of vectors) {
    const salt = streamSalt({
      donor: fromHex(vector.donor_hex),
      recipients: vector.recipients_hex.map(fromHex),
      shares: vector.shares,
      chunk: BigInt(vector.chunk),
      nChunks: Number(vector.n_chunks),
      t0: BigInt(vector.t0),
      period: BigInt(vector.period),
      resolver: fromHex(vector.resolver_hex),
      feeBps: vector.fee_bps,
      feeWallet: fromHex(vector.fee_wallet_hex),
      nonce: BigInt(vector.nonce),
    });
    assert.equal(hex(salt), vector.salt_hex);
  }
});

test("every birth field separates the salt", () => {
  const base = {
    donor: new Uint8Array(32).fill(0x11),
    recipients: [new Uint8Array(32).fill(0x22)],
    shares: [10_000],
    chunk: 1n,
    nChunks: 2,
    t0: 3n,
    period: 4n,
    resolver: new Uint8Array(32).fill(0x33),
    feeBps: 6,
    feeWallet: new Uint8Array(32).fill(0x44),
    nonce: 5n,
  };
  const reference = hex(streamSalt(base));
  const variants = [
    { ...base, donor: new Uint8Array(32).fill(0x12) },
    { ...base, recipients: [new Uint8Array(32).fill(0x23)] },
    { ...base, shares: [9_999] },
    { ...base, chunk: 2n },
    { ...base, nChunks: 3 },
    { ...base, t0: 4n },
    { ...base, period: 5n },
    { ...base, resolver: new Uint8Array(32).fill(0x34) },
    { ...base, feeBps: 7 },
    { ...base, feeWallet: new Uint8Array(32).fill(0x45) },
    { ...base, nonce: 6n },
  ];
  for (const variant of variants) {
    assert.notEqual(hex(streamSalt(variant)), reference);
  }
});
