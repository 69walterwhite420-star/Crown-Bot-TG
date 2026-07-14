// channel_id — 32 bytes naming the channel everywhere: the bot's records,
// the deep link, and the canister's derivation path (docs/bot-spec.md §2).
// Domain-prefixed so no other client of the subscription canister can
// collide with ours.

import { sha256 } from "@noble/hashes/sha2.js";

import { assertLength, concat, i64le, u64le, utf8 } from "./bytes.ts";

export const CHANNEL_ID_TAG = "crown:bot-tg:v1";

/**
 * channel_id = sha256("crown:bot-tg:v1" ‖ i64le(tg_chat_id) ‖
 * owner_wallet(32) ‖ u64le(setup_nonce))
 */
export function channelId(tgChatId: bigint, ownerWallet: Uint8Array, setupNonce: bigint): Uint8Array {
  assertLength(ownerWallet, 32, "owner wallet");
  return sha256(concat(utf8(CHANNEL_ID_TAG), i64le(tgChatId), ownerWallet, u64le(setupNonce)));
}

export const SETUP_SCOPE_TAG = "crown:bot-tg:setup";

/**
 * The channel field of the OWNER's setup challenge (docs/bot-spec.md §3):
 * the real channel_id derives from the owner's wallet, which the setup link
 * is about to learn — so the signature binds to the Telegram chat instead.
 * setup_scope = sha256("crown:bot-tg:setup" ‖ i64le(tg_chat_id))
 */
export function setupScopeId(tgChatId: bigint): Uint8Array {
  return sha256(concat(utf8(SETUP_SCOPE_TAG), i64le(tgChatId)));
}
