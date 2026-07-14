// The donor's cancel authorization — a byte mirror of the subscription
// canister's layout (crown-games/subscription, game-spec §8). The donor
// signs these bytes with the wallet; the canister verifies them against the
// donor field of the declared birth.

import { concat, lp, utf8 } from "./bytes.ts";

export const CANCEL_DOMAIN = "crown:subscription:v1";
export const ACTION_CANCEL = 0;

/**
 * message = DOMAIN ‖ lp(chain) ‖ lp(canister_id) ‖ lp(escrow) ‖ ACTION_CANCEL
 */
export function cancelAuthorization(
  chain: string,
  canisterId: Uint8Array,
  escrow: Uint8Array,
): Uint8Array {
  return concat(
    utf8(CANCEL_DOMAIN),
    lp(utf8(chain)),
    lp(canisterId),
    lp(escrow),
    new Uint8Array([ACTION_CANCEL]),
  );
}
