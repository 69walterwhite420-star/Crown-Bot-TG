// The instruction layer: discriminators recomputed from their anchor
// derivation, the shape messages byte for byte, the self-contained ed25519
// entry, and the borsh body of create_escrow.
import { test } from "node:test";
import assert from "node:assert/strict";

import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { concat, hex, i64le, u16le, u32le, u64le, utf8 } from "../src/bytes.ts";
import {
  CANCEL_TAG,
  DISCRIMINATORS,
  RELEASE_TAG,
  cancelMessage,
  createEscrowIx,
  ed25519VerifyIx,
  releaseIx,
  releaseMessage,
  type ChainAddresses,
} from "../src/instructions.ts";

const CHAIN: ChainAddresses = {
  factory: new PublicKey("2pezd2u8LFMFULRzV2ygdRmH6BNxxU4AoeD8RSGgCdxv"),
  usdc: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  splitter: new PublicKey("3R4dk7uuLt5rnuD95roDhQkt2ZKV9xMAFjfx1Eb96nxP"),
  treasury: new PublicKey("3it64t7KXNip1C1BRYNh8ygeKyujWnaQrPSj3hV9TWbE"),
};
const DOMAIN = "crown:stream:solana-devnet";

test("discriminators equal their anchor derivation", () => {
  for (const [name, pinned] of [
    ["create_escrow", DISCRIMINATORS.createEscrow],
    ["release", DISCRIMINATORS.release],
    ["cancel", DISCRIMINATORS.cancel],
    ["refund", DISCRIMINATORS.refund],
  ] as const) {
    assert.equal(hex(pinned), hex(sha256(utf8(`global:${name}`)).slice(0, 8)), name);
  }
});

test("the shape messages are pinned", () => {
  const factory = new PublicKey(new Uint8Array(32).fill(7));
  const escrow = new PublicKey(new Uint8Array(32).fill(9));
  assert.equal(
    hex(releaseMessage(DOMAIN, factory, escrow, 258)),
    hex(
      concat(
        utf8(DOMAIN),
        factory.toBytes(),
        escrow.toBytes(),
        new Uint8Array([RELEASE_TAG]),
        new Uint8Array([0x02, 0x01]),
      ),
    ),
  );
  assert.equal(
    hex(cancelMessage(DOMAIN, factory, escrow)),
    hex(concat(utf8(DOMAIN), factory.toBytes(), escrow.toBytes(), new Uint8Array([CANCEL_TAG]))),
  );
});

test("the ed25519 entry is self-contained", () => {
  const resolver = new Uint8Array(32).fill(1);
  const signature = new Uint8Array(64).fill(2);
  const message = utf8("message");
  const ix = ed25519VerifyIx(resolver, signature, message);
  const expected = concat(
    new Uint8Array([1, 0]),
    u16le(48),
    u16le(0xffff),
    u16le(16),
    u16le(0xffff),
    u16le(112),
    u16le(message.length),
    u16le(0xffff),
    resolver,
    signature,
    message,
  );
  assert.equal(hex(new Uint8Array(ix.data)), hex(expected));
  assert.equal(ix.keys.length, 0);
});

test("create_escrow carries the borsh birth and derives the address", () => {
  const donor = new Uint8Array(32).fill(0x11);
  const recipient = new Uint8Array(32).fill(0x22);
  const resolver = new Uint8Array(32).fill(0x33);
  const birth = {
    donor,
    recipients: [recipient],
    shares: [10_000],
    chunk: 40_000n,
    nChunks: 3,
    t0: -100n,
    period: 45n,
    resolver,
    nonce: 7n,
  };
  const { instruction, escrow } = createEscrowIx(birth, CHAIN);

  const expectedData = concat(
    DISCRIMINATORS.createEscrow,
    u32le(1),
    recipient,
    u32le(1),
    u16le(10_000),
    u64le(40_000n),
    u16le(3),
    i64le(-100n),
    i64le(45n),
    resolver,
    u64le(7n),
  );
  assert.equal(hex(new Uint8Array(instruction.data)), hex(expectedData));

  // The donor signs; the escrow is writable and matches the salt+PDA path.
  const first = instruction.keys[0];
  assert.ok(first && first.isSigner && first.isWritable);
  assert.equal(first.pubkey.toBase58(), new PublicKey(donor).toBase58());
  const escrowKey = instruction.keys[2];
  assert.ok(escrowKey && escrowKey.isWritable && !escrowKey.isSigner);
  assert.equal(escrowKey.pubkey.toBase58(), escrow.toBase58());
});

test("release appends one [recipient, ata] pair per nonzero share", () => {
  const escrow = new PublicKey(new Uint8Array(32).fill(9));
  const state = {
    donor: new Uint8Array(32).fill(0x11),
    recipients: [new Uint8Array(32).fill(0x22), new Uint8Array(32).fill(0x44)],
    shares: [9_000, 0],
  };
  const ix = releaseIx(escrow, state, 1, CHAIN);
  assert.equal(hex(new Uint8Array(ix.data)), hex(concat(DISCRIMINATORS.release, u16le(1))));
  // 10 fixed accounts + 1 pair (the zero share adds none).
  assert.equal(ix.keys.length, 12);
  const recipient = ix.keys[10];
  assert.ok(recipient && !recipient.isWritable);
  assert.equal(recipient.pubkey.toBase58(), new PublicKey(state.recipients[0]!).toBase58());
  const recipientAta = ix.keys[11];
  assert.ok(recipientAta && recipientAta.isWritable);
});
