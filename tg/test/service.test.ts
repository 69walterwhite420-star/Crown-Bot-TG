// B3 integration tests (docs/build-plan.md): the Service over a mock Bot
// API, fixture first-sources and a fake clock. No network anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { hex, utf8, type EscrowAccount } from "@crown/core";

import { BotDb } from "../src/db.ts";
import { Challenges } from "../src/challenges.ts";
import { Service } from "../src/service.ts";
import type { Sources } from "../src/sources.ts";

// ---- fixtures ---------------------------------------------------------------

const CHAT = -100123n;
const OWNER_TG = 10n;
const VIEWER_TG = 20n;
const OTHER_TG = 30n;
const RESOLVER = new Uint8Array(32).fill(0x77);
const PRICE = 40_000n;
const PERIOD = 100n;
const THRESHOLD = 500_000n;

interface TestWallet {
  secret: Uint8Array;
  pub: Uint8Array;
}
function walletOf(seed: number): TestWallet {
  const secret = new Uint8Array(32).fill(seed);
  return { secret, pub: ed25519.getPublicKey(secret) };
}
const OWNER_WALLET = walletOf(1);
const VIEWER_WALLET = walletOf(2);

class FakeClock {
  constructor(public time: bigint) {}
  now(): bigint {
    return this.time;
  }
  advance(seconds: bigint): void {
    this.time += seconds;
  }
}

class FakeTelegram {
  messages: { chatId: bigint; text: string }[] = [];
  approved: { chatId: bigint; userId: bigint }[] = [];
  kicked: { chatId: bigint; userId: bigint }[] = [];
  sendMessage(chatId: bigint, text: string): Promise<void> {
    this.messages.push({ chatId, text });
    return Promise.resolve();
  }
  approveJoinRequest(chatId: bigint, userId: bigint): Promise<void> {
    this.approved.push({ chatId, userId });
    return Promise.resolve();
  }
  kickMember(chatId: bigint, userId: bigint): Promise<void> {
    this.kicked.push({ chatId, userId });
    return Promise.resolve();
  }
}

class FakeSources implements Sources {
  reputations = new Map<string, bigint>();
  escrows: EscrowAccount[] = [];
  failReputation = false;
  reputation(wallet: Uint8Array): Promise<bigint> {
    if (this.failReputation) return Promise.reject(new Error("book unavailable"));
    return Promise.resolve(this.reputations.get(hex(wallet)) ?? 0n);
  }
  channelEscrows(): Promise<EscrowAccount[]> {
    return Promise.resolve(this.escrows);
  }
  resolverOf(): Promise<Uint8Array> {
    return Promise.resolve(RESOLVER);
  }
}

function escrowOf(donor: Uint8Array, t0: bigint, nChunks: number): EscrowAccount {
  return {
    donor,
    salt: new Uint8Array(32),
    resolver: RESOLVER,
    chunk: PRICE,
    nChunks,
    released: 0,
    t0,
    period: PERIOD,
    bump: 0,
    settled: false,
    recipients: [OWNER_WALLET.pub],
    shares: [10_000],
  };
}

function makeDeps(dbPath = ":memory:") {
  const db = new BotDb(dbPath);
  const clock = new FakeClock(1_000_000n);
  const telegram = new FakeTelegram();
  const sources = new FakeSources();
  const challenges = new Challenges("test_bot", 300n);
  const service = new Service({
    db,
    clock,
    telegram,
    sources,
    challenges,
    policy: {
      chainId: "solana-devnet",
      botUsername: "test_bot",
      rebindCooldown: 1_000n,
      maxWallets: 2,
      grace: 50n,
      renewNotice: 30n,
    },
  });
  return { db, clock, telegram, sources, challenges, service };
}

function nonceOf(challenge: string): string {
  const line = challenge.split("\n").find((entry) => entry.startsWith("nonce: "));
  assert.ok(line, "challenge carries a nonce");
  return line.slice("nonce: ".length);
}

function sign(wallet: TestWallet, text: string): Uint8Array {
  return ed25519.sign(utf8(text), wallet.secret);
}

type Deps = ReturnType<typeof makeDeps>;

async function setupChannel(deps: Deps, threshold = THRESHOLD): Promise<Uint8Array> {
  const challenge = deps.service.issueSetupChallenge(OWNER_TG, CHAT);
  const { channelId } = await deps.service.completeSetup({
    telegramId: OWNER_TG,
    tgChatId: CHAT,
    wallet: OWNER_WALLET.pub,
    signature: sign(OWNER_WALLET, challenge),
    nonce: nonceOf(challenge),
    price: PRICE,
    period: PERIOD,
    threshold,
  });
  return channelId;
}

async function linkViewer(
  deps: Deps,
  channelId: Uint8Array,
  telegramId = VIEWER_TG,
  wallet = VIEWER_WALLET,
): Promise<void> {
  const challenge = deps.service.issueChallenge(telegramId, channelId);
  await deps.service.completeLink({
    telegramId,
    wallet: wallet.pub,
    signature: sign(wallet, challenge),
    nonce: nonceOf(challenge),
  });
}

// ---- setup ------------------------------------------------------------------

test("setup: signed by the owner wallet, both-zero policy impossible", async () => {
  const deps = makeDeps();
  const channelId = await setupChannel(deps);
  const channel = deps.db.channelByChat(CHAT);
  assert.ok(channel);
  assert.equal(hex(channel.channelId), hex(channelId));
  assert.equal(hex(channel.resolver), hex(RESOLVER));
  assert.equal(channel.price, PRICE);
  assert.equal(channel.threshold, THRESHOLD);

  const challenge = deps.service.issueSetupChallenge(OWNER_TG, CHAT + 1n);
  await assert.rejects(
    deps.service.completeSetup({
      telegramId: OWNER_TG,
      tgChatId: CHAT + 1n,
      wallet: OWNER_WALLET.pub,
      signature: sign(OWNER_WALLET, challenge),
      nonce: nonceOf(challenge),
      price: 0n,
      period: 0n,
      threshold: 0n,
    }),
    /both entry rights disabled/,
  );
});

test("setup: a challenge for another chat does not configure this one", async () => {
  const deps = makeDeps();
  const challenge = deps.service.issueSetupChallenge(OWNER_TG, CHAT);
  await assert.rejects(
    deps.service.completeSetup({
      telegramId: OWNER_TG,
      tgChatId: CHAT + 1n, // not the chat the challenge was issued for
      wallet: OWNER_WALLET.pub,
      signature: sign(OWNER_WALLET, challenge),
      nonce: nonceOf(challenge),
      price: PRICE,
      period: PERIOD,
      threshold: THRESHOLD,
    }),
    /not a setup challenge/,
  );
});

// ---- linking ----------------------------------------------------------------

test("link: valid; expired, reused, foreign and forged are rejected", async () => {
  const deps = makeDeps();
  const channelId = await setupChannel(deps);

  // Valid.
  await linkViewer(deps, channelId);
  assert.ok(deps.db.activeBindingOfWallet(channelId, VIEWER_WALLET.pub));

  // Expired challenge.
  const expired = deps.service.issueChallenge(OTHER_TG, channelId);
  deps.clock.advance(301n);
  await assert.rejects(
    deps.service.completeLink({
      telegramId: OTHER_TG,
      wallet: walletOf(3).pub,
      signature: sign(walletOf(3), expired),
      nonce: nonceOf(expired),
    }),
    /expired/,
  );

  // Reused nonce.
  const once = deps.service.issueChallenge(OTHER_TG, channelId);
  const third = walletOf(3);
  await deps.service.completeLink({
    telegramId: OTHER_TG,
    wallet: third.pub,
    signature: sign(third, once),
    nonce: nonceOf(once),
  });
  await assert.rejects(
    deps.service.completeLink({
      telegramId: OTHER_TG,
      wallet: third.pub,
      signature: sign(third, once),
      nonce: nonceOf(once),
    }),
    /unknown or already used/,
  );

  // A challenge issued to another telegram account.
  const foreign = deps.service.issueChallenge(VIEWER_TG, channelId);
  await assert.rejects(
    deps.service.completeLink({
      telegramId: OTHER_TG,
      wallet: walletOf(4).pub,
      signature: sign(walletOf(4), foreign),
      nonce: nonceOf(foreign),
    }),
    /foreign telegram account/,
  );

  // A signature by a different key than the declared wallet.
  const forged = deps.service.issueChallenge(OTHER_TG, channelId);
  await assert.rejects(
    deps.service.completeLink({
      telegramId: OTHER_TG,
      wallet: walletOf(5).pub,
      signature: sign(walletOf(6), forged),
      nonce: nonceOf(forged),
    }),
    /bad signature/,
  );
});

test("rebind: kicks the old account, arms the cooldown; two accounts never share a wallet", async () => {
  const deps = makeDeps();
  const channelId = await setupChannel(deps);
  await linkViewer(deps, channelId, VIEWER_TG);

  // The viewer is a member; the wallet then moves to OTHER_TG.
  deps.db.insertMember({
    channelId,
    telegramId: VIEWER_TG,
    admittedAt: deps.clock.now(),
    admittedBy: "subscription",
    thresholdAtAdmission: THRESHOLD,
    graceStartedAt: null,
    kickedAt: null,
    renewalNotifiedUntil: null,
  });

  await linkViewer(deps, channelId, OTHER_TG, VIEWER_WALLET);
  assert.deepEqual(deps.telegram.kicked, [{ chatId: CHAT, userId: VIEWER_TG }]);
  const binding = deps.db.activeBindingOfWallet(channelId, VIEWER_WALLET.pub);
  assert.ok(binding && binding.telegramId === OTHER_TG, "the seat moved");
  assert.equal(
    deps.db.activeBindingsOfAccount(channelId, VIEWER_TG).length,
    0,
    "one wallet, one account",
  );

  // A second rebind inside the cooldown is rejected.
  await assert.rejects(linkViewer(deps, channelId, VIEWER_TG, VIEWER_WALLET), /cooldown/);
  // After the cooldown it works again.
  deps.clock.advance(1_001n);
  await linkViewer(deps, channelId, VIEWER_TG, VIEWER_WALLET);
});

test("max wallets per account is enforced", async () => {
  const deps = makeDeps();
  const channelId = await setupChannel(deps);
  await linkViewer(deps, channelId, VIEWER_TG, walletOf(2));
  await linkViewer(deps, channelId, VIEWER_TG, walletOf(3));
  await assert.rejects(linkViewer(deps, channelId, VIEWER_TG, walletOf(4)), /too many wallets/);
});

// ---- admission ----------------------------------------------------------------

test("join: reputation entry snapshots the admission threshold", async () => {
  const deps = makeDeps();
  const channelId = await setupChannel(deps);
  await linkViewer(deps, channelId);
  deps.sources.reputations.set(hex(VIEWER_WALLET.pub), THRESHOLD);

  await deps.service.handleJoinRequest(CHAT, VIEWER_TG);
  assert.deepEqual(deps.telegram.approved, [{ chatId: CHAT, userId: VIEWER_TG }]);
  const member = deps.db.member(channelId, VIEWER_TG);
  assert.ok(member);
  assert.equal(member.admittedBy, "reputation");
  assert.equal(member.thresholdAtAdmission, THRESHOLD);
});

test("join: subscription entry via a live escrow of a linked wallet", async () => {
  const deps = makeDeps();
  const channelId = await setupChannel(deps);
  await linkViewer(deps, channelId);
  deps.sources.escrows = [escrowOf(VIEWER_WALLET.pub, deps.clock.now(), 3)];

  await deps.service.handleJoinRequest(CHAT, VIEWER_TG);
  assert.equal(deps.telegram.approved.length, 1);
  assert.equal(deps.db.member(channelId, VIEWER_TG)?.admittedBy, "subscription");
});

test("join: an unbound request is left to the owner, never declined", async () => {
  const deps = makeDeps();
  await setupChannel(deps);
  await deps.service.handleJoinRequest(CHAT, 999n);
  assert.equal(deps.telegram.approved.length, 0);
  const note = deps.telegram.messages.find((message) => message.chatId === OWNER_TG);
  assert.ok(note && note.text.includes("не с платформы"));
});

test("join: bound but unentitled gets an explanation, no approval", async () => {
  const deps = makeDeps();
  const channelId = await setupChannel(deps);
  await linkViewer(deps, channelId);
  await deps.service.handleJoinRequest(CHAT, VIEWER_TG);
  assert.equal(deps.telegram.approved.length, 0);
  assert.ok(deps.telegram.messages.some((message) => message.chatId === VIEWER_TG));
});

// ---- revision -----------------------------------------------------------------

async function admittedSubscriber(deps: Deps): Promise<Uint8Array> {
  const channelId = await setupChannel(deps);
  await linkViewer(deps, channelId);
  deps.sources.escrows = [escrowOf(VIEWER_WALLET.pub, deps.clock.now(), 2)];
  await deps.service.handleJoinRequest(CHAT, VIEWER_TG);
  assert.equal(deps.telegram.approved.length, 1);
  return channelId;
}

test("revision: lost right → warning and grace → kick; only own records touched", async () => {
  const deps = makeDeps();
  const channelId = await admittedSubscriber(deps);

  // Window still paid: nothing happens.
  await deps.service.revision();
  assert.equal(deps.db.member(channelId, VIEWER_TG)?.graceStartedAt, null);

  // The paid window ends (2 chunks × 100s).
  deps.clock.advance(201n);
  await deps.service.revision();
  const member = deps.db.member(channelId, VIEWER_TG);
  assert.ok(member && member.graceStartedAt !== null, "grace started");
  assert.ok(
    deps.telegram.messages.some(
      (message) => message.chatId === VIEWER_TG && message.text.includes("льготный"),
    ),
    "the member was warned",
  );
  assert.equal(deps.telegram.kicked.length, 0, "no kick inside grace");

  // Grace (50s) passes.
  deps.clock.advance(51n);
  await deps.service.revision();
  assert.deepEqual(deps.telegram.kicked, [{ chatId: CHAT, userId: VIEWER_TG }]);
  assert.ok(deps.db.member(channelId, VIEWER_TG)?.kickedAt !== null);

  // The bot never touched anyone outside its records.
  for (const kick of deps.telegram.kicked) {
    assert.equal(kick.userId, VIEWER_TG);
  }
});

test("revision: a right restored during grace clears it", async () => {
  const deps = makeDeps();
  const channelId = await admittedSubscriber(deps);
  deps.clock.advance(201n);
  await deps.service.revision();
  assert.ok(deps.db.member(channelId, VIEWER_TG)?.graceStartedAt !== null);

  // A fresh subscription arrives before the grace runs out.
  deps.sources.escrows.push(escrowOf(VIEWER_WALLET.pub, deps.clock.now(), 3));
  deps.clock.advance(10n);
  await deps.service.revision();
  assert.equal(deps.db.member(channelId, VIEWER_TG)?.graceStartedAt, null);
  assert.equal(deps.telegram.kicked.length, 0);
});

test("revision: no data is not no right — a source failure touches nobody", async () => {
  const deps = makeDeps();
  const channelId = await admittedSubscriber(deps);
  deps.clock.advance(201n); // the right is actually lost…
  deps.sources.failReputation = true; // …but the book is unreachable
  await deps.service.revision();
  assert.equal(deps.db.member(channelId, VIEWER_TG)?.graceStartedAt, null);
  assert.equal(deps.telegram.kicked.length, 0);
});

// ---- reminders ----------------------------------------------------------------

test("reminders: renewal once per paid window, uncollected once per day", async () => {
  const deps = makeDeps();
  const channelId = await admittedSubscriber(deps);

  // Inside the renew notice (30s before the window ends at t0+200).
  deps.clock.advance(180n);
  await deps.service.revision();
  const renewals = () =>
    deps.telegram.messages.filter(
      (message) => message.chatId === VIEWER_TG && message.text.includes("Оплаченное окно"),
    ).length;
  assert.equal(renewals(), 1);
  await deps.service.revision();
  assert.equal(renewals(), 1, "no repeat for the same window");

  // Chunk 0 and 1 are long due and uncollected: the owner is nagged once.
  const nags = () =>
    deps.telegram.messages.filter(
      (message) => message.chatId === OWNER_TG && message.text.includes("Несобранных"),
    ).length;
  assert.equal(nags(), 1);
  await deps.service.revision();
  assert.equal(nags(), 1, "at most one nag per day");
  assert.ok(deps.db.channelById(channelId)?.uncollectedNotifiedAt !== null);
});

// ---- persistence ----------------------------------------------------------------

test("restart: the database survives, only pending challenges are lost", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crown-bot-")), "bot.db");
  const first = makeDeps(path);
  const channelId = await setupChannel(first);
  await linkViewer(first, channelId);
  first.db.close();

  const second = new BotDb(path);
  const channel = second.channelByChat(CHAT);
  assert.ok(channel, "channel survived");
  assert.ok(second.activeBindingOfWallet(channel.channelId, VIEWER_WALLET.pub), "binding survived");
  second.close();
});
