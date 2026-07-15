// Table tests of the admission law (docs/bot-spec.md §4): every branch,
// including the independence from `released` and the edges of the paid
// window.
import { test } from "node:test";
import assert from "node:assert/strict";

import { entitled, subscriptionAlive, type ChannelPolicy } from "../src/entitlement.ts";
import type { EscrowAccount } from "../src/escrow-account.ts";

const OWNER = new Uint8Array(32).fill(0x01);
const DONOR = new Uint8Array(32).fill(0x02);
const RESOLVER = new Uint8Array(32).fill(0x03);
const FEE_WALLET = new Uint8Array(32).fill(0x04);
const FEE_BPS = 300;

const policy: ChannelPolicy = {
  owner: OWNER,
  price: 40_000n,
  period: 2_592_000n,
  threshold: 500_000n,
  feeBps: FEE_BPS,
  feeWallet: FEE_WALLET,
};

function aliveEscrow(overrides: Partial<EscrowAccount> = {}): EscrowAccount {
  return {
    donor: DONOR,
    salt: new Uint8Array(32),
    resolver: RESOLVER,
    chunk: 40_000n,
    nChunks: 12,
    released: 0,
    t0: 1_000n,
    period: policy.period,
    feeBps: FEE_BPS,
    feeWallet: FEE_WALLET,
    bump: 254,
    settled: false,
    recipients: [OWNER],
    shares: [10_000],
    ...overrides,
  };
}

const NOW = 1_000n + 6n * policy.period; // inside the 12-chunk window

function alive(escrow: EscrowAccount, now = NOW): boolean {
  return subscriptionAlive(escrow, { donor: DONOR, resolver: RESOLVER, policy, now });
}

test("a healthy subscription is alive", () => {
  assert.ok(alive(aliveEscrow()));
});

test("access does not depend on released", () => {
  assert.ok(alive(aliveEscrow({ released: 0 })));
  assert.ok(alive(aliveEscrow({ released: 6 })));
  assert.ok(alive(aliveEscrow({ released: 11 })));
});

test("every violated condition kills the subscription", () => {
  const cases: [string, EscrowAccount][] = [
    ["foreign resolver", aliveEscrow({ resolver: new Uint8Array(32).fill(9) })],
    ["foreign donor", aliveEscrow({ donor: new Uint8Array(32).fill(9) })],
    ["foreign recipient", aliveEscrow({ recipients: [new Uint8Array(32).fill(9)] })],
    ["two recipients", aliveEscrow({ recipients: [OWNER, DONOR], shares: [5000, 5000] })],
    ["partial share", aliveEscrow({ shares: [9_999] })],
    ["under price", aliveEscrow({ chunk: 39_999n })],
    ["foreign fee bps", aliveEscrow({ feeBps: 0 })],
    ["foreign fee wallet", aliveEscrow({ feeWallet: new Uint8Array(32).fill(9) })],
    ["wrong period", aliveEscrow({ period: policy.period + 1n })],
    ["terminal", aliveEscrow({ settled: true })],
  ];
  for (const [name, escrow] of cases) {
    assert.equal(alive(escrow), false, name);
  }
});

test("the paid window edges are exact", () => {
  const escrow = aliveEscrow();
  const paidUntil = escrow.t0 + BigInt(escrow.nChunks) * escrow.period;
  assert.ok(alive(escrow, paidUntil - 1n), "one second before the window ends");
  assert.equal(alive(escrow, paidUntil), false, "the window end is exclusive");
});

test("a higher chunk than the price still qualifies", () => {
  assert.ok(alive(aliveEscrow({ chunk: 50_000n })));
});

test("price zero disables the subscription path", () => {
  const disabled = { ...policy, price: 0n };
  const escrow = aliveEscrow({ chunk: 1n });
  assert.equal(
    subscriptionAlive(escrow, { donor: DONOR, resolver: RESOLVER, policy: disabled, now: NOW }),
    false,
  );
});

test("entitled: reputation gate, subscription, both, neither", () => {
  assert.ok(entitled({ reputationSum: 500_000n, threshold: 500_000n, hasLiveSubscription: false }));
  assert.ok(entitled({ reputationSum: 0n, threshold: 500_000n, hasLiveSubscription: true }));
  assert.ok(entitled({ reputationSum: 900_000n, threshold: 500_000n, hasLiveSubscription: true }));
  assert.equal(
    entitled({ reputationSum: 499_999n, threshold: 500_000n, hasLiveSubscription: false }),
    false,
  );
});

test("threshold zero disables the reputation gate", () => {
  assert.equal(
    entitled({ reputationSum: 10n ** 18n, threshold: 0n, hasLiveSubscription: false }),
    false,
  );
});
