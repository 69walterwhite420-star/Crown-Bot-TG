// Transaction builders of the stream shape: instruction data (Anchor
// discriminators + borsh args) and account lists mirroring the deployed
// program's Accounts structs. Discriminators are pinned constants; the
// layout tests recompute them from sha256("global:<name>").

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import { concat, fromHex, i64le, u16le, u32le, u64le, utf8 } from "./bytes.ts";
import type { EscrowAccount } from "./escrow-account.ts";
import { escrowAddressOfBirth } from "./escrow-address.ts";
import type { StreamBirth } from "./salt.ts";

/** sha256("global:<name>")[..8], pinned; the tests recompute them. */
export const DISCRIMINATORS = {
  createEscrow: fromHex("fdd7a574246c4450"),
  release: fromHex("fdf90fce1c7fc1f1"),
  cancel: fromHex("e8dbdf29dbecdcbe"),
  refund: fromHex("0260b7fb3fd02e2e"),
} as const;

export const RELEASE_TAG = 0x00;
export const CANCEL_TAG = 0x01;

/** The chain's fixed addresses, from config (docs/bot-spec.md §9). */
export interface ChainAddresses {
  factory: PublicKey;
  usdc: PublicKey;
  splitter: PublicKey;
}

export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  // Escrows are PDAs — off the curve is expected.
  return getAssociatedTokenAddressSync(mint, owner, true);
}

/** DOMAIN ‖ program ‖ escrow ‖ [0x00, index le] — the release message. */
export function releaseMessage(
  domain: string,
  factory: PublicKey,
  escrow: PublicKey,
  index: number,
): Uint8Array {
  return concat(
    utf8(domain),
    factory.toBytes(),
    escrow.toBytes(),
    new Uint8Array([RELEASE_TAG]),
    u16le(index),
  );
}

/** DOMAIN ‖ program ‖ escrow ‖ [0x01] — the cancel message. */
export function cancelMessage(domain: string, factory: PublicKey, escrow: PublicKey): Uint8Array {
  return concat(utf8(domain), factory.toBytes(), escrow.toBytes(), new Uint8Array([CANCEL_TAG]));
}

/**
 * The ed25519_program instruction the escrow demands directly before
 * release/cancel: one self-contained signature entry — every offset points
 * into this instruction itself.
 */
export function ed25519VerifyIx(
  resolver: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): TransactionInstruction {
  const data = concat(
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
  return new TransactionInstruction({
    programId: new PublicKey("Ed25519SigVerify111111111111111111111111111"),
    keys: [],
    data: Buffer.from(data),
  });
}

/** create_escrow: births and funds the stream in one transaction. */
export function createEscrowIx(
  birth: StreamBirth,
  chain: ChainAddresses,
): { instruction: TransactionInstruction; escrow: PublicKey } {
  const escrow = escrowAddressOfBirth(birth, chain.factory);
  const donor = new PublicKey(birth.donor);
  const data = concat(
    DISCRIMINATORS.createEscrow,
    u32le(birth.recipients.length),
    ...birth.recipients,
    u32le(birth.shares.length),
    ...birth.shares.map(u16le),
    u64le(birth.chunk),
    u16le(birth.nChunks),
    i64le(birth.t0),
    i64le(birth.period),
    birth.resolver,
    u16le(birth.feeBps),
    birth.feeWallet,
    u64le(birth.nonce),
  );
  const instruction = new TransactionInstruction({
    programId: chain.factory,
    keys: [
      { pubkey: donor, isSigner: true, isWritable: true },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
  return { instruction, escrow };
}

function splitterEventAuthority(splitter: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8("__event_authority")], splitter)[0];
}

/**
 * release(index): the chunk through the splitter. Pairs of
 * [recipient, recipient ATA] follow the fixed accounts in birth order, one
 * pair per nonzero share.
 */
export function releaseIx(
  escrow: PublicKey,
  state: Pick<EscrowAccount, "donor" | "recipients" | "shares" | "feeWallet">,
  index: number,
  chain: ChainAddresses,
): TransactionInstruction {
  const donor = new PublicKey(state.donor);
  // The fee leaves to the ATA of the wallet the escrow itself was born
  // with; the program pins the address, this list only supplies it.
  const feeWallet = new PublicKey(state.feeWallet);
  const keys = [
    { pubkey: escrow, isSigner: false, isWritable: true },
    { pubkey: chain.usdc, isSigner: false, isWritable: false },
    { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
    { pubkey: donor, isSigner: false, isWritable: true },
    { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
    { pubkey: ata(feeWallet, chain.usdc), isSigner: false, isWritable: true },
    { pubkey: splitterEventAuthority(chain.splitter), isSigner: false, isWritable: false },
    { pubkey: chain.splitter, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  state.recipients.forEach((recipient, position) => {
    if (state.shares[position] === 0) return;
    const wallet = new PublicKey(recipient);
    keys.push({ pubkey: wallet, isSigner: false, isWritable: false });
    keys.push({ pubkey: ata(wallet, chain.usdc), isSigner: false, isWritable: true });
  });
  return new TransactionInstruction({
    programId: chain.factory,
    keys,
    data: Buffer.from(concat(DISCRIMINATORS.release, u16le(index))),
  });
}

/** cancel(): the whole unreleased remainder back to the donor. Terminal. */
export function cancelIx(
  escrow: PublicKey,
  state: Pick<EscrowAccount, "donor">,
  chain: ChainAddresses,
): TransactionInstruction {
  const donor = new PublicKey(state.donor);
  return new TransactionInstruction({
    programId: chain.factory,
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: donor, isSigner: false, isWritable: true },
      { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(DISCRIMINATORS.cancel)),
  });
}

/** refund(): the dead-stream insurance — no signature at all. Terminal. */
export function refundIx(
  escrow: PublicKey,
  state: Pick<EscrowAccount, "donor">,
  chain: ChainAddresses,
): TransactionInstruction {
  const donor = new PublicKey(state.donor);
  return new TransactionInstruction({
    programId: chain.factory,
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: donor, isSigner: false, isWritable: true },
      { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(DISCRIMINATORS.refund)),
  });
}
