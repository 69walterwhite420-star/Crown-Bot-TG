// The admission law (docs/bot-spec.md §4) as pure functions of passed data.
// Network clients live elsewhere; these predicates are what the table tests
// pin. Access never depends on `released`: collection is the owner's
// business, membership is the paid window of a live escrow.

import { bytesEqual } from "./bytes.ts";
import type { EscrowAccount } from "./escrow-account.ts";

export interface ChannelPolicy {
  /** The owner's wallet — the recipient of every subscription. */
  owner: Uint8Array;
  /** Minor units of USDC per period; 0 = subscriptions disabled. */
  price: bigint;
  /** Seconds; the exact period a subscription escrow must carry. */
  period: bigint;
  /** Minor units of reputation; 0 = the reputation gate is disabled. */
  threshold: bigint;
}

/** The full row of the subscription shape: one recipient, the whole chunk. */
const FULL_SHARE = 10_000;

/**
 * A live subscription of `donor` to the channel: every condition of §4 at
 * once, over the escrow account's own fields.
 */
export function subscriptionAlive(
  escrow: EscrowAccount,
  args: {
    donor: Uint8Array;
    resolver: Uint8Array;
    policy: ChannelPolicy;
    /** Unix seconds. */
    now: bigint;
  },
): boolean {
  const { donor, resolver, policy, now } = args;
  if (policy.price === 0n) return false;
  const paidUntil = escrow.t0 + BigInt(escrow.nChunks) * escrow.period;
  return (
    bytesEqual(escrow.resolver, resolver) &&
    bytesEqual(escrow.donor, donor) &&
    escrow.recipients.length === 1 &&
    escrow.recipients[0] !== undefined &&
    bytesEqual(escrow.recipients[0], policy.owner) &&
    escrow.shares.length === 1 &&
    escrow.shares[0] === FULL_SHARE &&
    escrow.chunk >= policy.price &&
    escrow.period === policy.period &&
    !escrow.settled &&
    now < paidUntil
  );
}

/**
 * The account's right to enter: the reputation gate (forever, when enabled)
 * or any live subscription of any linked wallet. The reputation sum is the
 * caller's job — it is read from the book per wallet and added up.
 */
export function entitled(args: {
  reputationSum: bigint;
  threshold: bigint;
  hasLiveSubscription: boolean;
}): boolean {
  const byReputation = args.threshold > 0n && args.reputationSum >= args.threshold;
  return byReputation || args.hasLiveSubscription;
}
