// The SIWS link challenge (docs/bot-spec.md §3): a human-readable text of a
// frozen layout — wallets show it to the signer. Every binding lives in the
// signed bytes: bot, channel, telegram account, one-time nonce, expiry.
// Changing the layout means changing the version tag.

import { hex } from "./bytes.ts";

export const CHALLENGE_TAG = "crown-bot-tg v1";

export interface Challenge {
  botUsername: string;
  channelId: Uint8Array;
  telegramId: bigint;
  nonce: Uint8Array;
  /** Unix seconds. */
  expires: bigint;
}

export function buildChallenge(challenge: Challenge): string {
  return [
    CHALLENGE_TAG,
    `bot: ${challenge.botUsername}`,
    `channel: ${hex(challenge.channelId)}`,
    `telegram: ${challenge.telegramId}`,
    "action: link",
    `nonce: ${hex(challenge.nonce)}`,
    `expires: ${challenge.expires}`,
  ].join("\n");
}
