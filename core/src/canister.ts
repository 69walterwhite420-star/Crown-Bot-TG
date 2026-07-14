// First-source readers on ICP: the subscription resolver canister and the
// book (crown-index). The IDL mirrors the canisters' .did files; every
// method used here is permissionless. Plain reads in v1 — accepted
// (docs/bot-spec.md §10.4).

import { Actor, type ActorSubclass, type Agent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import type { Principal } from "@dfinity/principal";

const Blob = IDL.Vec(IDL.Nat8);

const ReleaseArg = IDL.Record({
  chain: IDL.Text,
  subscription_id: Blob,
  donor: Blob,
  recipients: IDL.Vec(Blob),
  shares: IDL.Vec(IDL.Nat16),
  chunk: IDL.Nat64,
  n_chunks: IDL.Nat16,
  t0: IDL.Int64,
  period: IDL.Int64,
  nonce: IDL.Nat64,
  index: IDL.Nat16,
});
const CancelArg = IDL.Record({
  chain: IDL.Text,
  subscription_id: Blob,
  donor: Blob,
  recipients: IDL.Vec(Blob),
  shares: IDL.Vec(IDL.Nat16),
  chunk: IDL.Nat64,
  n_chunks: IDL.Nat16,
  t0: IDL.Int64,
  period: IDL.Int64,
  nonce: IDL.Nat64,
  signature: Blob,
});
const SignedRelease = IDL.Record({ escrow: Blob, index: IDL.Nat16, signature: Blob });
const SignedCancel = IDL.Record({ escrow: Blob, signature: Blob });
const result = (ok: IDL.Type) => IDL.Variant({ Ok: ok, Err: IDL.Text });

export const subscriptionIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_resolver: IDL.Func([IDL.Text, Blob], [result(Blob)], []),
    request_release: IDL.Func([ReleaseArg], [result(SignedRelease)], []),
    request_cancel: IDL.Func([CancelArg], [result(SignedCancel)], []),
    get_logic_version: IDL.Func([], [IDL.Nat32], ["query"]),
  });

export const crownIndexIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_reputation: IDL.Func([IDL.Text, Blob, Blob], [IDL.Nat], ["query"]),
  });

type CandidResult<T> = { Ok: T } | { Err: string };

export interface BirthFields {
  donor: Uint8Array;
  recipients: Uint8Array[];
  shares: number[];
  chunk: bigint;
  nChunks: number;
  t0: bigint;
  period: bigint;
  nonce: bigint;
}

export interface SubscriptionActor {
  get_resolver(chain: string, subscriptionId: Uint8Array): Promise<CandidResult<Uint8Array>>;
  request_release(
    arg: BirthFields & { chain: string; subscriptionId: Uint8Array; index: number },
  ): Promise<CandidResult<{ escrow: Uint8Array; index: number; signature: Uint8Array }>>;
  request_cancel(
    arg: BirthFields & { chain: string; subscriptionId: Uint8Array; signature: Uint8Array },
  ): Promise<CandidResult<{ escrow: Uint8Array; signature: Uint8Array }>>;
}

interface RawSubscriptionService {
  get_resolver(chain: string, id: number[] | Uint8Array): Promise<CandidResult<Uint8Array | number[]>>;
  request_release(arg: object): Promise<CandidResult<{ escrow: Uint8Array | number[]; index: number; signature: Uint8Array | number[] }>>;
  request_cancel(arg: object): Promise<CandidResult<{ escrow: Uint8Array | number[]; signature: Uint8Array | number[] }>>;
}

interface RawCrownIndexService {
  get_reputation(chain: string, payer: number[] | Uint8Array, streamer: number[] | Uint8Array): Promise<bigint>;
}

function asBytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function rawBirth(arg: BirthFields & { chain: string; subscriptionId: Uint8Array }) {
  return {
    chain: arg.chain,
    subscription_id: arg.subscriptionId,
    donor: arg.donor,
    recipients: arg.recipients,
    shares: arg.shares,
    chunk: arg.chunk,
    n_chunks: arg.nChunks,
    t0: arg.t0,
    period: arg.period,
    nonce: arg.nonce,
  };
}

export function subscriptionActor(agent: Agent, canisterId: Principal | string): SubscriptionActor {
  const raw = Actor.createActor(subscriptionIdl, { agent, canisterId }) as ActorSubclass<RawSubscriptionService>;
  return {
    async get_resolver(chain, subscriptionId) {
      const out = await raw.get_resolver(chain, subscriptionId);
      return "Ok" in out ? { Ok: asBytes(out.Ok) } : out;
    },
    async request_release(arg) {
      const out = await raw.request_release({ ...rawBirth(arg), index: arg.index });
      return "Ok" in out
        ? { Ok: { escrow: asBytes(out.Ok.escrow), index: out.Ok.index, signature: asBytes(out.Ok.signature) } }
        : out;
    },
    async request_cancel(arg) {
      const out = await raw.request_cancel({ ...rawBirth(arg), signature: arg.signature });
      return "Ok" in out
        ? { Ok: { escrow: asBytes(out.Ok.escrow), signature: asBytes(out.Ok.signature) } }
        : out;
    },
  };
}

export interface CrownIndexActor {
  /** book[(chain, payer, streamer)] in minor units of reputation. */
  get_reputation(chain: string, payer: Uint8Array, streamer: Uint8Array): Promise<bigint>;
}

export function crownIndexActor(agent: Agent, canisterId: Principal | string): CrownIndexActor {
  const raw = Actor.createActor(crownIndexIdl, { agent, canisterId }) as ActorSubclass<RawCrownIndexService>;
  return {
    get_reputation: (chain, payer, streamer) => raw.get_reputation(chain, payer, streamer),
  };
}
