// The wiring: grammY long polling over the Service. All logic lives in
// service.ts behind injected dependencies; this file only translates
// Telegram updates into service calls and service results into messages.

import { readFileSync } from "node:fs";

import { Bot, Keyboard } from "grammy";
import { Connection, PublicKey } from "@solana/web3.js";
import { HttpAgent } from "@dfinity/agent";
import { hex, fromHex } from "@crown/core";

import { BotDb } from "./db.ts";
import { Challenges } from "./challenges.ts";
import { Service } from "./service.ts";
import { liveSources } from "./sources.ts";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`env ${name} is required`);
  return value;
}

function configValue(toml: string, key: string): string {
  return toml.match(new RegExp(`^${key}\\s*=\\s*"?([^"\\n]*)"?`, "m"))?.[1]?.trim() ?? "";
}

function webAppUrl(base: string, action: string, payload: Record<string, string>): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString("base64url");
  return `${base}#${action}=${b64}`;
}

async function main(): Promise<void> {
  const profile = env("CROWN_PROFILE", "testnet");
  const toml = readFileSync(new URL(`../../config/${profile}.toml`, import.meta.url), "utf8");
  const chainId = configValue(toml, "id");
  const subscriptionCanisterId =
    configValue(toml, "subscription") || env("SUBSCRIPTION_CANISTER");
  const crownIndexCanisterId = configValue(toml, "crown_index") || env("CROWN_INDEX_CANISTER");
  const icHost = env("IC_HOST", "https://icp-api.io");
  const miniappUrl = configValue(toml, "miniapp_url") || env("MINIAPP_URL");
  const policyNumber = (key: string): bigint => BigInt(configValue(toml, key) || "0");

  const bot = new Bot(env("BOT_TOKEN"));
  const me = await bot.api.getMe();

  const db = new BotDb(env("DB_PATH", "crown-bot.db"));
  const clock = { now: () => BigInt(Math.floor(Date.now() / 1000)) };
  const challenges = new Challenges(me.username, policyNumber("challenge_ttl"));
  const agent = await HttpAgent.create({
    host: icHost,
    shouldFetchRootKey: icHost.includes("127.0.0.1") || icHost.includes("localhost"),
  });
  const sources = liveSources({
    connection: new Connection(configValue(toml, "rpc"), "confirmed"),
    agent,
    chainId,
    factory: new PublicKey(configValue(toml, "factory_stream")),
    subscriptionCanisterId,
    crownIndexCanisterId,
  });
  const service = new Service({
    db,
    clock,
    telegram: {
      sendMessage: async (chatId, text) => {
        await bot.api.sendMessage(Number(chatId), text);
      },
      approveJoinRequest: async (chatId, userId) => {
        await bot.api.approveChatJoinRequest(Number(chatId), Number(userId));
      },
      kickMember: async (chatId, userId) => {
        // Ban+unban: enforcement, not a curse — the account may re-apply.
        await bot.api.banChatMember(Number(chatId), Number(userId));
        await bot.api.unbanChatMember(Number(chatId), Number(userId));
      },
    },
    sources,
    challenges,
    policy: {
      chainId,
      botUsername: me.username,
      rebindCooldown: policyNumber("rebind_cooldown"),
      maxWallets: Number(policyNumber("max_wallets")),
      grace: policyNumber("grace"),
      renewNotice: policyNumber("renew_notice"),
    },
  });

  // Setup state of this process: who is configuring which chat. A restart
  // loses it — the owner starts over, nothing durable is affected.
  const pendingChats = new Map<number, bigint>();
  const pendingPolicies = new Map<
    number,
    { tgChatId: bigint; price: bigint; period: bigint; threshold: bigint }
  >();

  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember;
    if (update.chat.type !== "channel") return;
    if (update.new_chat_member.status !== "administrator") return;
    pendingChats.set(update.from.id, BigInt(update.chat.id));
    await bot.api.sendMessage(
      update.from.id,
      `Канал «${update.chat.title}» готов к настройке. Пришлите мне:\n` +
        `/setup <цена за период, minor USDC> <период, сек> <порог репутации, minor>\n` +
        `0 отключает соответствующий вход (оба нуля нельзя).`,
    );
  });

  bot.command("setup", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const tgChatId = pendingChats.get(ctx.from.id);
    if (tgChatId === undefined) {
      await ctx.reply("Сначала добавьте бота админом в свой канал.");
      return;
    }
    const parts = (ctx.match ?? "").trim().split(/\s+/);
    if (parts.length !== 3) {
      await ctx.reply("Формат: /setup <цена> <период_сек> <порог>");
      return;
    }
    const [price, period, threshold] = parts.map((part) => BigInt(part));
    pendingPolicies.set(ctx.from.id, {
      tgChatId,
      price: price ?? 0n,
      period: period ?? 0n,
      threshold: threshold ?? 0n,
    });
    const challenge = service.issueSetupChallenge(BigInt(ctx.from.id), tgChatId);
    await ctx.reply("Подпишите кошельком владельца — он станет получателем подписок:", {
      reply_markup: new Keyboard()
        .webApp("Подписать", webAppUrl(miniappUrl, "link", { challenge }))
        .oneTime(),
    });
  });

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const payload = (ctx.match ?? "").trim();
    if (!/^[0-9a-f]{64}$/.test(payload)) {
      await ctx.reply("Откройте ссылку канала вида t.me/…?start=<id>.");
      return;
    }
    const channel = db.channelById(fromHex(payload));
    if (!channel) {
      await ctx.reply("Канал не найден.");
      return;
    }
    const challenge = service.issueChallenge(BigInt(ctx.from.id), channel.channelId);
    const card =
      `Приватный канал.\n` +
      (channel.threshold > 0n ? `Вход навсегда: репутация ≥ ${channel.threshold}.\n` : "") +
      (channel.price > 0n
        ? `Подписка: ${channel.price} minor USDC за ${channel.period} сек.\n`
        : "") +
      `Сначала привяжите кошелёк, затем подайте заявку на вступление.`;
    const keyboard = new Keyboard().webApp(
      "Привязать кошелёк",
      webAppUrl(miniappUrl, "link", { challenge }),
    );
    if (channel.price > 0n) {
      keyboard.row().webApp(
        "Подписаться",
        webAppUrl(miniappUrl, "subscribe", {
          channelId: hex(channel.channelId),
          resolver: hex(channel.resolver),
          owner: new PublicKey(channel.ownerWallet).toBase58(),
          price: channel.price.toString(),
          period: channel.period.toString(),
          subscription: subscriptionCanisterId,
          icHost,
        }),
      );
    }
    await ctx.reply(card, { reply_markup: keyboard.oneTime() });
  });

  bot.on("message:web_app_data", async (ctx) => {
    if (!ctx.from) return;
    const raw = ctx.message.web_app_data.data;
    try {
      const data = JSON.parse(raw) as { wallet: string; signature: string; nonce: string };
      const wallet = new PublicKey(data.wallet).toBytes();
      const signature = new Uint8Array(Buffer.from(data.signature, "base64"));
      const telegramId = BigInt(ctx.from.id);

      const setup = pendingPolicies.get(ctx.from.id);
      if (setup) {
        pendingPolicies.delete(ctx.from.id);
        const { deepLink } = await service.completeSetup({
          telegramId,
          tgChatId: setup.tgChatId,
          wallet,
          signature,
          nonce: data.nonce,
          price: setup.price,
          period: setup.period,
          threshold: setup.threshold,
        });
        await ctx.reply(`Канал настроен. Ссылка для зрителей:\n${deepLink}`);
        return;
      }

      const { rebound } = await service.completeLink({
        telegramId,
        wallet,
        signature,
        nonce: data.nonce,
      });
      await ctx.reply(
        rebound
          ? "Кошелёк перепривязан к этому аккаунту. Подайте заявку на вступление в канал."
          : "Кошелёк привязан. Подайте заявку на вступление в канал.",
      );
    } catch (error) {
      await ctx.reply(`Не получилось: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.on("chat_join_request", async (ctx) => {
    await service.handleJoinRequest(
      BigInt(ctx.chatJoinRequest.chat.id),
      BigInt(ctx.chatJoinRequest.from.id),
    );
  });

  const revisionPeriod = Number(policyNumber("revision_period"));
  setInterval(() => {
    void service.revision();
  }, revisionPeriod * 1000);

  console.log(`@${me.username} polling; revision every ${revisionPeriod}s`);
  await bot.start();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
