// The escrow address: PDA([b"escrow", salt], factory) — the same arithmetic
// the core's indexer and the canister use. The PDA derivation itself is
// web3.js, never re-implemented.

import { PublicKey } from "@solana/web3.js";

import { utf8 } from "./bytes.ts";
import { type StreamBirth, streamSalt } from "./salt.ts";

export function escrowAddress(salt: Uint8Array, factory: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8("escrow"), salt], factory)[0];
}

export function escrowAddressOfBirth(birth: StreamBirth, factory: PublicKey): PublicKey {
  return escrowAddress(streamSalt(birth), factory);
}
