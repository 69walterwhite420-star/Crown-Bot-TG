// The service logic (docs/bot-spec.md §3–§5) over injected dependencies:
// db, clock, telegram, first sources, policy. main.ts wires it to grammY;
// the integration tests drive it with mocks and a fake clock. The bot's
// jurisdiction is its own records — nothing else is ever touched.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  bytesEqual,
  channelId as deriveChannelId,
  entitled,
  hex,
  setupScopeId,
  subscriptionAlive,
  utf8,
  type ChannelPolicy,
  type EscrowAccount,
} from "@crown/core";

import type { BotDb, ChannelRow, MemberRow } from "./db.ts";
import type { Challenges } from "./challenges.ts";
import type { Sources } from "./sources.ts";
import type { TelegramApi } from "./telegram.ts";

export interface Clock {
  now(): bigint;
}

export interface Policy {
  chainId: string;
  botUsername: string;
  rebindCooldown: bigint;
  maxWallets: number;
  grace: bigint;
  renewNotice: bigint;
}

export interface ServiceDeps {
  db: BotDb;
  clock: Clock;
  telegram: TelegramApi;
  sources: Sources;
  challenges: Challenges;
  policy: Policy;
}

function policyOf(channel: ChannelRow): ChannelPolicy {
  return {
    owner: channel.ownerWallet,
    price: channel.price,
    period: channel.period,
    threshold: channel.threshold,
  };
}

export class Service {
  constructor(private deps: ServiceDeps) {}

  // ---- setup ------------------------------------------------------------

  /**
   * Registers a channel (bot-spec §5): the policy must enable at least one
   * entry right; the resolver is derived once and cached — it is
   * deterministic. Returns the deep link the owner publishes.
   */
  async setupChannel(args: {
    tgChatId: bigint;
    ownerTelegramId: bigint;
    ownerWallet: Uint8Array;
    price: bigint;
    period: bigint;
    threshold: bigint;
  }): Promise<{ channelId: Uint8Array; deepLink: string }> {
    const { db, clock, sources, policy } = this.deps;
    if (args.price === 0n && args.threshold === 0n) {
      throw new Error("setup: both entry rights disabled");
    }
    if (args.price > 0n && args.period <= 0n) {
      throw new Error("setup: subscription needs a positive period");
    }
    if (db.channelByChat(args.tgChatId)) {
      throw new Error("setup: channel already registered");
    }
    const now = clock.now();
    const channelId = deriveChannelId(args.tgChatId, args.ownerWallet, now);
    const resolver = await sources.resolverOf(channelId);
    db.insertChannel({
      channelId,
      tgChatId: args.tgChatId,
      ownerWallet: args.ownerWallet,
      ownerTelegramId: args.ownerTelegramId,
      setupNonce: now,
      resolver,
      price: args.price,
      period: args.period,
      threshold: args.threshold,
      createdAt: now,
    });
    // The member's door: a request-to-join link the bot can approve on.
    const invite = await this.deps.telegram.createInviteLink(args.tgChatId);
    db.setInviteLink(channelId, invite);
    return { channelId, deepLink: `https://t.me/${policy.botUsername}?start=${hex(channelId)}` };
  }

  /**
   * Completes the OWNER's setup (bot-spec §3, §5): the challenge was bound
   * to the setup scope of the chat — the real channel_id derives from the
   * wallet this signature just proved.
   */
  async completeSetup(args: {
    telegramId: bigint;
    tgChatId: bigint;
    wallet: Uint8Array;
    signature: Uint8Array;
    nonce: string;
    price: bigint;
    period: bigint;
    threshold: bigint;
  }): Promise<{ channelId: Uint8Array; deepLink: string }> {
    const { challenges, clock } = this.deps;
    const challenge = challenges.consume(args.nonce, args.telegramId, clock.now());
    if (!bytesEqual(challenge.channelId, setupScopeId(args.tgChatId))) {
      throw new Error("setup: challenge is not a setup challenge for this chat");
    }
    if (!ed25519.verify(args.signature, utf8(challenge.text), args.wallet)) {
      throw new Error("setup: bad signature");
    }
    return this.setupChannel({
      tgChatId: args.tgChatId,
      ownerTelegramId: args.telegramId,
      ownerWallet: args.wallet,
      price: args.price,
      period: args.period,
      threshold: args.threshold,
    });
  }

  // ---- linking ----------------------------------------------------------

  issueChallenge(telegramId: bigint, channelId: Uint8Array): string {
    return this.deps.challenges.issue(telegramId, channelId, this.deps.clock.now()).text;
  }

  issueSetupChallenge(telegramId: bigint, tgChatId: bigint): string {
    return this.deps.challenges.issue(telegramId, setupScopeId(tgChatId), this.deps.clock.now())
      .text;
  }

  /**
   * Completes a link (bot-spec §3): one-time nonce, exact signed bytes, the
   * binding invariants — a wallet holds at most one active account per
   * channel (rebind kicks the old one and starts the cooldown), an account
   * holds at most maxWallets wallets. The nonce names the channel.
   */
  async completeLink(args: {
    telegramId: bigint;
    wallet: Uint8Array;
    signature: Uint8Array;
    nonce: string;
  }): Promise<{ rebound: boolean; channelId: Uint8Array }> {
    const { db, clock, telegram, challenges, policy } = this.deps;
    const now = clock.now();

    const challenge = challenges.consume(args.nonce, args.telegramId, now);
    const channelId = challenge.channelId;
    const channel = db.channelById(channelId);
    if (!channel) throw new Error("link: unknown channel");
    if (!ed25519.verify(args.signature, utf8(challenge.text), args.wallet)) {
      throw new Error("link: bad signature");
    }

    const active = db.activeBindingOfWallet(channelId, args.wallet);
    if (active && active.telegramId === args.telegramId) {
      return { rebound: false, channelId }; // idempotent
    }

    let rebound = false;
    if (active) {
      // Rebind: the wallet's seat moves; the old account loses it now. The
      // cooldown lives on the binding being displaced — set when the wallet
      // last moved, so a first bind (cooldown 0) is displaceable at once.
      if (active.cooldownUntil > now) {
        throw new Error("link: rebind cooldown");
      }
      db.unbind(channelId, args.wallet, now);
      const oldMember = db.member(channelId, active.telegramId);
      if (oldMember && oldMember.kickedAt === null) {
        await telegram.kickMember(channel.tgChatId, active.telegramId);
        db.markKicked(channelId, active.telegramId, now);
        await telegram.sendMessage(
          active.telegramId,
          "Кошелёк привязан к другому Telegram-аккаунту; доступ по нему перешёл туда.",
        );
      }
      rebound = true;
    }

    if (db.activeBindingsOfAccount(channelId, args.telegramId).length >= policy.maxWallets) {
      throw new Error("link: too many wallets on this account");
    }

    db.insertBinding({
      channelId,
      wallet: args.wallet,
      telegramId: args.telegramId,
      boundAt: now,
      cooldownUntil: rebound ? now + policy.rebindCooldown : 0n,
    });
    return { rebound, channelId };
  }

  // ---- admission --------------------------------------------------------

  /**
   * The §4 law over first sources for one account. Source failures must
   * never read as "no right" — they throw, and the caller decides
   * (a join request stays pending, a revision skips the member).
   */
  private async evaluate(
    channel: ChannelRow,
    telegramId: bigint,
    threshold: bigint,
  ): Promise<{ entitled: boolean; by: "reputation" | "subscription"; paidUntil: bigint | null }> {
    const { db, clock, sources } = this.deps;
    const wallets = db.activeBindingsOfAccount(channel.channelId, telegramId);
    const now = clock.now();

    let reputationSum = 0n;
    for (const binding of wallets) {
      reputationSum += await sources.reputation(binding.wallet, channel.ownerWallet);
    }

    let live: EscrowAccount | null = null;
    if (channel.price > 0n && wallets.length > 0) {
      const escrows = await sources.channelEscrows(channel.resolver);
      for (const escrow of escrows) {
        const owned = wallets.some((binding) => bytesEqual(binding.wallet, escrow.donor));
        if (
          owned &&
          subscriptionAlive(escrow, {
            donor: escrow.donor,
            resolver: channel.resolver,
            policy: policyOf(channel),
            now,
          })
        ) {
          if (!live || paidUntilOf(escrow) > paidUntilOf(live)) live = escrow;
        }
      }
    }

    const byReputation = threshold > 0n && reputationSum >= threshold;
    return {
      entitled: entitled({ reputationSum, threshold, hasLiveSubscription: live !== null }),
      by: byReputation ? "reputation" : "subscription",
      paidUntil: live ? paidUntilOf(live) : null,
    };
  }

  /**
   * A join request (bot-spec §5): with no binding it is left to the owner —
   * never declined; with a binding the §4 law decides. Admission snapshots
   * the threshold: raising it later never evicts.
   */
  async handleJoinRequest(tgChatId: bigint, telegramId: bigint): Promise<void> {
    const { db, clock, telegram } = this.deps;
    const channel = db.channelByChat(tgChatId);
    if (!channel) return;

    const bindings = db.activeBindingsOfAccount(channel.channelId, telegramId);
    if (bindings.length === 0) {
      await telegram.sendMessage(
        channel.ownerTelegramId,
        `Заявка не с платформы (telegram id ${telegramId}) — оставлена вам на решение.`,
      );
      return;
    }

    const verdict = await this.evaluate(channel, telegramId, channel.threshold);
    if (!verdict.entitled) {
      await telegram.sendMessage(
        telegramId,
        "Права входа пока нет: нужна подписка или репутация у владельца канала.",
      );
      return;
    }
    await telegram.approveJoinRequest(tgChatId, telegramId);
    db.insertMember({
      channelId: channel.channelId,
      telegramId,
      admittedAt: clock.now(),
      admittedBy: verdict.by,
      thresholdAtAdmission: channel.threshold,
      graceStartedAt: null,
      kickedAt: null,
      renewalNotifiedUntil: null,
    });
  }

  // ---- revision ---------------------------------------------------------

  /**
   * The periodic pass (bot-spec §5): re-evaluates every member of every
   * channel from first sources. Lost right → warning and grace; grace over
   * → kick. Members outside the bot's records do not exist for this loop,
   * and a source failure skips the member — no data is not no right.
   */
  async revision(): Promise<void> {
    const { db } = this.deps;
    for (const channel of db.allChannels()) {
      for (const member of db.activeMembers(channel.channelId)) {
        try {
          await this.reviseMember(channel, member);
        } catch {
          // First source unavailable: the member is untouched this pass.
        }
      }
      try {
        await this.remindOwnerOfUncollected(channel);
      } catch {
        // Reminders are best-effort.
      }
    }
  }

  private async reviseMember(channel: ChannelRow, member: MemberRow): Promise<void> {
    const { db, clock, telegram, policy } = this.deps;
    const now = clock.now();
    // The member's own admission threshold: raising the channel's bar never
    // evicts those already inside.
    const verdict = await this.evaluate(channel, member.telegramId, member.thresholdAtAdmission);

    if (verdict.entitled) {
      if (member.graceStartedAt !== null) {
        db.setGrace(channel.channelId, member.telegramId, null);
      }
      if (verdict.paidUntil !== null && verdict.paidUntil - now <= policy.renewNotice) {
        if (member.renewalNotifiedUntil !== verdict.paidUntil) {
          await telegram.sendMessage(
            member.telegramId,
            `Оплаченное окно подписки заканчивается; продлить — новый эскроу тем же флоу.`,
          );
          db.markRenewalNotified(channel.channelId, member.telegramId, verdict.paidUntil);
        }
      }
      return;
    }

    if (member.graceStartedAt === null) {
      db.setGrace(channel.channelId, member.telegramId, now);
      await telegram.sendMessage(
        member.telegramId,
        "Право входа потеряно (подписка кончилась?). Есть льготный период — продлите, иначе доступ закроется.",
      );
      return;
    }
    if (now >= member.graceStartedAt + policy.grace) {
      await telegram.kickMember(channel.tgChatId, member.telegramId);
      db.markKicked(channel.channelId, member.telegramId, now);
    }
  }

  /** Uncollected due chunks — the owner risks refund() past the margin. */
  private async remindOwnerOfUncollected(channel: ChannelRow): Promise<void> {
    const { db, clock, telegram, sources } = this.deps;
    const now = clock.now();
    const escrows = await sources.channelEscrows(channel.resolver);
    const dueCount = escrows.reduce((count, escrow) => {
      if (escrow.settled) return count;
      let due = 0;
      for (let index = escrow.released; index < escrow.nChunks; index++) {
        if (escrow.t0 + BigInt(index) * escrow.period > now) break;
        due++;
      }
      return count + due;
    }, 0);
    if (dueCount === 0) return;
    // At most one reminder per day: the nag must not become noise.
    if (channel.uncollectedNotifiedAt !== null && now - channel.uncollectedNotifiedAt < 86_400n) {
      return;
    }
    await telegram.sendMessage(
      channel.ownerTelegramId,
      `Несобранных кусков: ${dueCount}. Несобранное подписчики вправе вернуть себе по марже — соберите.`,
    );
    db.markUncollectedNotified(channel.channelId, now);
  }
}

function paidUntilOf(escrow: EscrowAccount): bigint {
  return escrow.t0 + BigInt(escrow.nChunks) * escrow.period;
}
