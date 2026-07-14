// First-source reads on Solana: the chain is the database of subscriptions
// (docs/bot-spec.md §6, §7). Discovery is getProgramAccounts with memcmp
// over the escrow header offsets; nothing is cached here.

import type { Connection, GetProgramAccountsFilter } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { DONOR_OFFSET, RESOLVER_OFFSET, decodeEscrow, type EscrowAccount } from "./escrow-account.ts";

/** memcmp filters over the escrow header: donor@8, resolver@72. */
export function escrowFilters(by: {
  donor?: Uint8Array;
  resolver?: Uint8Array;
}): GetProgramAccountsFilter[] {
  const filters: GetProgramAccountsFilter[] = [];
  if (by.donor) {
    filters.push({
      memcmp: { offset: DONOR_OFFSET, bytes: new PublicKey(by.donor).toBase58() },
    });
  }
  if (by.resolver) {
    filters.push({
      memcmp: { offset: RESOLVER_OFFSET, bytes: new PublicKey(by.resolver).toBase58() },
    });
  }
  return filters;
}

export interface FoundEscrow {
  address: PublicKey;
  escrow: EscrowAccount;
}

export async function findEscrows(
  connection: Connection,
  factory: PublicKey,
  filters: GetProgramAccountsFilter[],
): Promise<FoundEscrow[]> {
  const accounts = await connection.getProgramAccounts(factory, { filters });
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    escrow: decodeEscrow(new Uint8Array(account.data)),
  }));
}

export async function fetchEscrow(
  connection: Connection,
  address: PublicKey,
): Promise<EscrowAccount | null> {
  const account = await connection.getAccountInfo(address);
  return account ? decodeEscrow(new Uint8Array(account.data)) : null;
}
