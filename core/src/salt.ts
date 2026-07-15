// The stream shape's birth salt — the third implementation of this byte
// format after the deployed program and crown-salt (docs/bot-spec.md §8).
// Never edited by eye: the reference is vectors/stream-salt.json, a byte
// copy of the factory's fixtures, cross-checked there against python and
// the on-chain program. A one-byte drift derives an address where no
// escrow will ever live.

import { sha256 } from "@noble/hashes/sha2.js";

import { assertLength, concat, i64le, u16le, u64le } from "./bytes.ts";

export interface StreamBirth {
  donor: Uint8Array;
  recipients: Uint8Array[];
  /** Ten-thousandths of the chunk, one share per recipient. */
  shares: number[];
  chunk: bigint;
  nChunks: number;
  t0: bigint;
  period: bigint;
  resolver: Uint8Array;
  /** The resolver operator's price tag — birth fields like the rest. */
  feeBps: number;
  feeWallet: Uint8Array;
  nonce: bigint;
}

/**
 * salt = sha256(donor ‖ K(u8) ‖ recipients ‖ shares(u16 LE) ‖ chunk_le ‖
 * n_chunks_le ‖ t0_le ‖ period_le ‖ resolver ‖ fee_bps_le ‖ fee_wallet ‖
 * nonce_le)
 */
export function streamSalt(birth: StreamBirth): Uint8Array {
  assertLength(birth.donor, 32, "donor");
  assertLength(birth.resolver, 32, "resolver");
  const parts: Uint8Array[] = [birth.donor, new Uint8Array([birth.recipients.length])];
  for (const recipient of birth.recipients) {
    assertLength(recipient, 32, "recipient");
    parts.push(recipient);
  }
  for (const share of birth.shares) {
    parts.push(u16le(share));
  }
  parts.push(u64le(birth.chunk));
  parts.push(u16le(birth.nChunks));
  parts.push(i64le(birth.t0));
  parts.push(i64le(birth.period));
  parts.push(birth.resolver);
  assertLength(birth.feeWallet, 32, "feeWallet");
  parts.push(u16le(birth.feeBps));
  parts.push(birth.feeWallet);
  parts.push(u64le(birth.nonce));
  return sha256(concat(...parts));
}
