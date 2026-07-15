// Decoder of the stream shape's Escrow account. The header offsets are the
// convention the whole platform reads (factory-spec §2.1): donor at 8..40,
// salt at 40..72; this shape keeps its resolver at 72..104. Pinned by a
// fixture of a real devnet account born by the deployed program.

import { bytesEqual } from "./bytes.ts";

/** sha256("account:Escrow")[..8] — the convention's shared discriminator. */
export const ESCROW_DISCRIMINATOR = new Uint8Array([31, 213, 123, 187, 186, 22, 218, 155]);

export const DONOR_OFFSET = 8;
export const SALT_OFFSET = 40;
export const RESOLVER_OFFSET = 72;

export interface EscrowAccount {
  donor: Uint8Array;
  salt: Uint8Array;
  resolver: Uint8Array;
  chunk: bigint;
  nChunks: number;
  /** Chunks released so far; also the index of the next chunk due. */
  released: number;
  t0: bigint;
  period: bigint;
  /** The resolver operator's price tag, born with the escrow. */
  feeBps: number;
  feeWallet: Uint8Array;
  bump: number;
  /** Terminal: cancel, refund, or the last chunk released. */
  settled: boolean;
  recipients: Uint8Array[];
  shares: number[];
}

export function decodeEscrow(data: Uint8Array): EscrowAccount {
  if (!bytesEqual(data.slice(0, 8), ESCROW_DISCRIMINATOR)) {
    throw new Error("not a stream Escrow account");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = DONOR_OFFSET;
  const take = (length: number): Uint8Array => {
    const part = data.slice(offset, offset + length);
    if (part.length !== length) throw new Error("truncated escrow account");
    offset += length;
    return part;
  };

  const donor = take(32);
  const salt = take(32);
  const resolver = take(32);
  const chunk = view.getBigUint64(offset, true);
  offset += 8;
  const nChunks = view.getUint16(offset, true);
  offset += 2;
  const released = view.getUint16(offset, true);
  offset += 2;
  const t0 = view.getBigInt64(offset, true);
  offset += 8;
  const period = view.getBigInt64(offset, true);
  offset += 8;
  const feeBps = view.getUint16(offset, true);
  offset += 2;
  const feeWallet = take(32);
  const bump = view.getUint8(offset);
  offset += 1;
  const settled = view.getUint8(offset) !== 0;
  offset += 1;

  const recipientCount = view.getUint32(offset, true);
  offset += 4;
  const recipients: Uint8Array[] = [];
  for (let i = 0; i < recipientCount; i++) {
    recipients.push(take(32));
  }
  const shareCount = view.getUint32(offset, true);
  offset += 4;
  const shares: number[] = [];
  for (let i = 0; i < shareCount; i++) {
    shares.push(view.getUint16(offset, true));
    offset += 2;
  }

  return {
    donor,
    salt,
    resolver,
    chunk,
    nChunks,
    released,
    t0,
    period,
    feeBps,
    feeWallet,
    bump,
    settled,
    recipients,
    shares,
  };
}
