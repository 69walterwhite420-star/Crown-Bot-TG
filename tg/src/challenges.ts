// The one-time challenge store (docs/bot-spec.md §3): process memory only —
// a restart invalidates pending links, the user just taps again. Every
// binding of the signed text is re-checked at consumption.

import { randomBytes } from "node:crypto";

import { buildChallenge, hex } from "@crown/core";

export interface IssuedChallenge {
  text: string;
  nonce: string;
}

interface Pending {
  telegramId: bigint;
  channelId: Uint8Array;
  expires: bigint;
}

export class Challenges {
  private pending = new Map<string, Pending>();

  constructor(
    private botUsername: string,
    private ttl: bigint,
  ) {}

  issue(telegramId: bigint, channelId: Uint8Array, now: bigint): IssuedChallenge {
    const nonce = randomBytes(16);
    const expires = now + this.ttl;
    const text = buildChallenge({
      botUsername: this.botUsername,
      channelId,
      telegramId,
      nonce,
      expires,
    });
    this.pending.set(hex(nonce), { telegramId, channelId, expires });
    return { text, nonce: hex(nonce) };
  }

  /**
   * One-time: a consumed or expired nonce never verifies again. The nonce
   * itself names the channel — the page's payload carries no channel field
   * to lie about.
   */
  consume(
    nonce: string,
    telegramId: bigint,
    now: bigint,
  ): { text: string; channelId: Uint8Array } {
    const pending = this.pending.get(nonce);
    if (!pending) throw new Error("challenge: unknown or already used nonce");
    this.pending.delete(nonce);
    if (pending.expires < now) throw new Error("challenge: expired");
    if (pending.telegramId !== telegramId) throw new Error("challenge: foreign telegram account");
    // Rebuild the exact signed text: the signature is over these bytes.
    const text = buildChallenge({
      botUsername: this.botUsername,
      channelId: pending.channelId,
      telegramId,
      nonce: Uint8Array.from(Buffer.from(nonce, "hex")),
      expires: pending.expires,
    });
    return { text, channelId: pending.channelId };
  }
}
