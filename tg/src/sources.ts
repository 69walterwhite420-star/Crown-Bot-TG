// First sources behind one interface (docs/bot-spec.md §4, §8): the book
// for reputation, the chain for escrows, the canister for resolver keys.
// The service never caches what these return; the tests replace them with
// fixtures — CI makes no network calls.

import { Connection, PublicKey } from "@solana/web3.js";
import type { Agent } from "@dfinity/agent";
import {
  crownIndexActor,
  escrowFilters,
  findEscrows,
  subscriptionActor,
  type EscrowAccount,
} from "@crown/core";

export interface Sources {
  /** book[(chain, wallet, owner)] in minor units. */
  reputation(wallet: Uint8Array, owner: Uint8Array): Promise<bigint>;
  /** Every escrow account born with the channel's resolver. */
  channelEscrows(resolver: Uint8Array): Promise<EscrowAccount[]>;
  /** The derived resolver key of a channel id. */
  resolverOf(channelId: Uint8Array): Promise<Uint8Array>;
}

export function liveSources(args: {
  connection: Connection;
  agent: Agent;
  chainId: string;
  factory: PublicKey;
  subscriptionCanisterId: string;
  crownIndexCanisterId: string;
}): Sources {
  const subscription = subscriptionActor(args.agent, args.subscriptionCanisterId);
  const book = crownIndexActor(args.agent, args.crownIndexCanisterId);
  return {
    reputation: (wallet, owner) => book.get_reputation(args.chainId, wallet, owner),
    async channelEscrows(resolver) {
      const found = await findEscrows(args.connection, args.factory, escrowFilters({ resolver }));
      return found.map((entry) => entry.escrow);
    },
    async resolverOf(channelId) {
      const out = await subscription.get_resolver(args.chainId, channelId);
      if ("Err" in out) throw new Error(`get_resolver: ${out.Err}`);
      return out.Ok;
    },
  };
}
