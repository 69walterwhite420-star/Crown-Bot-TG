// The bot's whole persistent truth (docs/bot-spec.md §7): channel policies
// and wallet↔telegram bindings — the social facts that exist nowhere on
// chain. Everything monetary is read from first sources on every check.
// bigint money values are stored as TEXT: SQLite integers are signed 64,
// JSON numbers lose precision — text never lies.

import Database from "better-sqlite3";

const SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE channels (
      channel_id        BLOB PRIMARY KEY,
      tg_chat_id        INTEGER NOT NULL,
      owner_wallet      BLOB NOT NULL,
      owner_telegram_id INTEGER NOT NULL,
      setup_nonce       INTEGER NOT NULL,
      resolver          BLOB NOT NULL,
      price             TEXT NOT NULL,
      period            INTEGER NOT NULL,
      threshold         TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      uncollected_notified_at INTEGER
    );
    CREATE UNIQUE INDEX channels_by_chat ON channels (tg_chat_id);

    CREATE TABLE bindings (
      channel_id     BLOB NOT NULL,
      wallet         BLOB NOT NULL,
      telegram_id    INTEGER NOT NULL,
      bound_at       INTEGER NOT NULL,
      unbound_at     INTEGER,
      cooldown_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX bindings_active_wallet
      ON bindings (channel_id, wallet) WHERE unbound_at IS NULL;

    CREATE TABLE members (
      channel_id             BLOB NOT NULL,
      telegram_id            INTEGER NOT NULL,
      admitted_at            INTEGER NOT NULL,
      admitted_by            TEXT NOT NULL,
      threshold_at_admission TEXT NOT NULL,
      grace_started_at       INTEGER,
      kicked_at              INTEGER,
      renewal_notified_until INTEGER,
      PRIMARY KEY (channel_id, telegram_id)
    );
  `,
  // The channel's own request-to-join invite link, created by the bot at
  // setup: the deep link leads to the bot, the invite link to the channel.
  2: `ALTER TABLE channels ADD COLUMN invite_link TEXT;`,
};

export interface ChannelRow {
  channelId: Uint8Array;
  tgChatId: bigint;
  ownerWallet: Uint8Array;
  ownerTelegramId: bigint;
  setupNonce: bigint;
  resolver: Uint8Array;
  price: bigint;
  period: bigint;
  threshold: bigint;
  createdAt: bigint;
  uncollectedNotifiedAt: bigint | null;
  inviteLink: string | null;
}

export interface BindingRow {
  channelId: Uint8Array;
  wallet: Uint8Array;
  telegramId: bigint;
  boundAt: bigint;
  unboundAt: bigint | null;
  cooldownUntil: bigint;
}

export interface MemberRow {
  channelId: Uint8Array;
  telegramId: bigint;
  admittedAt: bigint;
  admittedBy: "reputation" | "subscription";
  thresholdAtAdmission: bigint;
  graceStartedAt: bigint | null;
  kickedAt: bigint | null;
  renewalNotifiedUntil: bigint | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>;

function channelOf(row: Raw): ChannelRow {
  return {
    channelId: new Uint8Array(row.channel_id),
    tgChatId: BigInt(row.tg_chat_id),
    ownerWallet: new Uint8Array(row.owner_wallet),
    ownerTelegramId: BigInt(row.owner_telegram_id),
    setupNonce: BigInt(row.setup_nonce),
    resolver: new Uint8Array(row.resolver),
    price: BigInt(row.price),
    period: BigInt(row.period),
    threshold: BigInt(row.threshold),
    createdAt: BigInt(row.created_at),
    uncollectedNotifiedAt:
      row.uncollected_notified_at === null ? null : BigInt(row.uncollected_notified_at),
    inviteLink: row.invite_link ?? null,
  };
}

function bindingOf(row: Raw): BindingRow {
  return {
    channelId: new Uint8Array(row.channel_id),
    wallet: new Uint8Array(row.wallet),
    telegramId: BigInt(row.telegram_id),
    boundAt: BigInt(row.bound_at),
    unboundAt: row.unbound_at === null ? null : BigInt(row.unbound_at),
    cooldownUntil: BigInt(row.cooldown_until),
  };
}

function memberOf(row: Raw): MemberRow {
  return {
    channelId: new Uint8Array(row.channel_id),
    telegramId: BigInt(row.telegram_id),
    admittedAt: BigInt(row.admitted_at),
    admittedBy: row.admitted_by,
    thresholdAtAdmission: BigInt(row.threshold_at_admission),
    graceStartedAt: row.grace_started_at === null ? null : BigInt(row.grace_started_at),
    kickedAt: row.kicked_at === null ? null : BigInt(row.kicked_at),
    renewalNotifiedUntil:
      row.renewal_notified_until === null ? null : BigInt(row.renewal_notified_until),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class BotDb {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
      const migration = MIGRATIONS[version];
      if (!migration) throw new Error(`no migration to version ${version}`);
      this.db.exec(migration);
      this.db.pragma(`user_version = ${version}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- channels ---------------------------------------------------------

  setInviteLink(channelId: Uint8Array, link: string): void {
    this.db
      .prepare("UPDATE channels SET invite_link = ? WHERE channel_id = ?")
      .run(link, Buffer.from(channelId));
  }

  insertChannel(channel: Omit<ChannelRow, "uncollectedNotifiedAt" | "inviteLink">): void {
    this.db
      .prepare(
        `INSERT INTO channels (channel_id, tg_chat_id, owner_wallet, owner_telegram_id,
         setup_nonce, resolver, price, period, threshold, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Buffer.from(channel.channelId),
        channel.tgChatId,
        Buffer.from(channel.ownerWallet),
        channel.ownerTelegramId,
        channel.setupNonce,
        Buffer.from(channel.resolver),
        channel.price.toString(),
        channel.period,
        channel.threshold.toString(),
        channel.createdAt,
      );
  }

  channelByChat(tgChatId: bigint): ChannelRow | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE tg_chat_id = ?").get(tgChatId);
    return row ? channelOf(row as never) : null;
  }

  channelById(channelId: Uint8Array): ChannelRow | null {
    const row = this.db
      .prepare("SELECT * FROM channels WHERE channel_id = ?")
      .get(Buffer.from(channelId));
    return row ? channelOf(row as never) : null;
  }

  allChannels(): ChannelRow[] {
    return this.db
      .prepare("SELECT * FROM channels")
      .all()
      .map((row) => channelOf(row as never));
  }

  markUncollectedNotified(channelId: Uint8Array, at: bigint): void {
    this.db
      .prepare("UPDATE channels SET uncollected_notified_at = ? WHERE channel_id = ?")
      .run(at, Buffer.from(channelId));
  }

  // ---- bindings ---------------------------------------------------------

  activeBindingOfWallet(channelId: Uint8Array, wallet: Uint8Array): BindingRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM bindings WHERE channel_id = ? AND wallet = ? AND unbound_at IS NULL",
      )
      .get(Buffer.from(channelId), Buffer.from(wallet));
    return row ? bindingOf(row as never) : null;
  }

  /** Channels where the account holds at least one active binding. */
  channelsOfAccount(telegramId: bigint): ChannelRow[] {
    return this.db
      .prepare(
        `SELECT channels.* FROM channels
         JOIN bindings ON bindings.channel_id = channels.channel_id
         WHERE bindings.telegram_id = ? AND bindings.unbound_at IS NULL
         GROUP BY channels.channel_id`,
      )
      .all(telegramId)
      .map((row) => channelOf(row as never));
  }

  /** Channels owned by the account — the /collect surface. */
  channelsOwnedBy(telegramId: bigint): ChannelRow[] {
    return this.db
      .prepare("SELECT * FROM channels WHERE owner_telegram_id = ?")
      .all(telegramId)
      .map((row) => channelOf(row as never));
  }

  activeBindingsOfAccount(channelId: Uint8Array, telegramId: bigint): BindingRow[] {
    return this.db
      .prepare(
        "SELECT * FROM bindings WHERE channel_id = ? AND telegram_id = ? AND unbound_at IS NULL",
      )
      .all(Buffer.from(channelId), telegramId)
      .map((row) => bindingOf(row as never));
  }

  insertBinding(binding: Omit<BindingRow, "unboundAt">): void {
    this.db
      .prepare(
        `INSERT INTO bindings (channel_id, wallet, telegram_id, bound_at, cooldown_until)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        Buffer.from(binding.channelId),
        Buffer.from(binding.wallet),
        binding.telegramId,
        binding.boundAt,
        binding.cooldownUntil,
      );
  }

  unbind(channelId: Uint8Array, wallet: Uint8Array, at: bigint): void {
    this.db
      .prepare(
        `UPDATE bindings SET unbound_at = ?
         WHERE channel_id = ? AND wallet = ? AND unbound_at IS NULL`,
      )
      .run(at, Buffer.from(channelId), Buffer.from(wallet));
  }

  // ---- members ----------------------------------------------------------

  member(channelId: Uint8Array, telegramId: bigint): MemberRow | null {
    const row = this.db
      .prepare("SELECT * FROM members WHERE channel_id = ? AND telegram_id = ?")
      .get(Buffer.from(channelId), telegramId);
    return row ? memberOf(row as never) : null;
  }

  activeMembers(channelId: Uint8Array): MemberRow[] {
    return this.db
      .prepare("SELECT * FROM members WHERE channel_id = ? AND kicked_at IS NULL")
      .all(Buffer.from(channelId))
      .map((row) => memberOf(row as never));
  }

  insertMember(member: MemberRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO members (channel_id, telegram_id, admitted_at, admitted_by,
         threshold_at_admission, grace_started_at, kicked_at, renewal_notified_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Buffer.from(member.channelId),
        member.telegramId,
        member.admittedAt,
        member.admittedBy,
        member.thresholdAtAdmission.toString(),
        member.graceStartedAt,
        member.kickedAt,
        member.renewalNotifiedUntil,
      );
  }

  setGrace(channelId: Uint8Array, telegramId: bigint, graceStartedAt: bigint | null): void {
    this.db
      .prepare("UPDATE members SET grace_started_at = ? WHERE channel_id = ? AND telegram_id = ?")
      .run(graceStartedAt, Buffer.from(channelId), telegramId);
  }

  markKicked(channelId: Uint8Array, telegramId: bigint, at: bigint): void {
    this.db
      .prepare("UPDATE members SET kicked_at = ? WHERE channel_id = ? AND telegram_id = ?")
      .run(at, Buffer.from(channelId), telegramId);
  }

  markRenewalNotified(channelId: Uint8Array, telegramId: bigint, paidUntil: bigint): void {
    this.db
      .prepare(
        "UPDATE members SET renewal_notified_until = ? WHERE channel_id = ? AND telegram_id = ?",
      )
      .run(paidUntil, Buffer.from(channelId), telegramId);
  }
}
