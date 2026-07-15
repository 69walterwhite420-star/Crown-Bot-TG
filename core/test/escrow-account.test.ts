// The decoder against a REAL devnet account, born by the deployed stream
// program during the subscription game's e2e (2026-07-15, the fee-bearing
// shape). The strongest cross-check ties everything together: the PDA of
// the stored salt must equal the account's own address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PublicKey } from "@solana/web3.js";

import { hex } from "../src/bytes.ts";
import { decodeEscrow, RESOLVER_OFFSET, DONOR_OFFSET } from "../src/escrow-account.ts";
import { escrowAddress } from "../src/escrow-address.ts";

const FACTORY = new PublicKey("57MpCQ3TfAE66qDAnfkP9AX7LRqwd4CNX8uN6DaVwm3V");

interface Fixture {
  address: string;
  owner: string;
  data_base64: string;
}

function loadFixture(): { fixture: Fixture; data: Uint8Array } {
  const url = new URL("./fixtures/escrow-account.json", import.meta.url);
  const fixture = JSON.parse(readFileSync(url, "utf8")) as Fixture;
  return { fixture, data: new Uint8Array(Buffer.from(fixture.data_base64, "base64")) };
}

test("the real devnet escrow decodes to its e2e birth", () => {
  const { fixture, data } = loadFixture();
  assert.equal(fixture.owner, FACTORY.toBase58(), "account owned by the stream factory");

  const escrow = decodeEscrow(data);
  assert.equal(escrow.chunk, 40_000n);
  assert.equal(escrow.nChunks, 3);
  assert.equal(escrow.released, 2);
  assert.equal(escrow.period, 45n);
  assert.equal(escrow.feeBps, 300, "the platform's price tag, born with the escrow");
  assert.equal(
    hex(escrow.feeWallet),
    hex(new PublicKey("3it64t7KXNip1C1BRYNh8ygeKyujWnaQrPSj3hV9TWbE").toBytes()),
  );
  assert.equal(escrow.settled, true, "cancelled by the donor in the e2e");
  assert.equal(escrow.recipients.length, 1);
  assert.deepEqual(escrow.shares, [10_000]);

  // Header convention offsets are what the memcmp filters rely on.
  assert.equal(hex(data.slice(DONOR_OFFSET, DONOR_OFFSET + 32)), hex(escrow.donor));
  assert.equal(hex(data.slice(RESOLVER_OFFSET, RESOLVER_OFFSET + 32)), hex(escrow.resolver));
});

test("the stored salt re-derives the account's own address", () => {
  const { fixture, data } = loadFixture();
  const escrow = decodeEscrow(data);
  // The address notarizes the birth: PDA([b"escrow", salt], factory) of the
  // decoded salt must be the account's own address — the same arithmetic the
  // core's indexer trusts. (The full salt recomputation from fields runs in
  // salt.test.ts over the factory vectors; the e2e nonce is not stored.)
  assert.equal(
    escrowAddress(escrow.salt, FACTORY).toBase58(),
    fixture.address,
    "PDA of the stored salt is the account address",
  );
});
