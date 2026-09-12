import { ForbiddenException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";

/**
 * F1 — the permission a confirmed AI proposal actually costs.
 *
 * `inventory:ai:propose` buys the right to ask the model for a proposal. It has
 * never bought the right to raise the purchase order at the end of one, and
 * before this file the confirm route was gated on `ai:propose` alone: a user
 * holding only that key could POST `/inventory/ai/reorder-proposal/confirm` and
 * a draft PO appeared, with no `inventory:purchase-orders:create` anywhere in
 * the path. The AI surface was a way around the procurement gate.
 *
 * The fix is a conjunction, and it lives here rather than only on the decorator
 * because `@RequirePermission` takes exactly one key — so the second half of the
 * requirement is not expressible as a decorator at all, and a route added later
 * would silently carry only the first half. The service asserts it; the
 * decorator states the half it can.
 *
 * The table is keyed on the `AiConfirmationService` action string, not on the
 * route, because the action is what the *stored proposal* says it is. A token
 * minted for one action and replayed against another route is checked against
 * the authority its own action demands, so the route cannot be used to launder
 * a cheaper permission into an expensive act.
 */
export const INV_AI_CONFIRMABLE_ACTIONS = {
  /**
   * `getReorderProposal` proposes under this action; `confirmReorderProposal`
   * turns it into a draft purchase order through the PO service.
   */
  "inventory:create-draft-po": [
    "inventory:ai:propose",
    "inventory:purchase-orders:create",
  ],
  /**
   * The transfer equivalent. Nothing in this subtree proposes it yet — the
   * replenishment engine owns transfer recommendations — but the entry exists
   * so that whoever wires the confirm route cannot reach a stock movement with
   * `ai:propose` alone. Adding the route later costs nothing; noticing the
   * missing conjunction later costs a warehouse.
   */
  "inventory:create-transfer": [
    "inventory:ai:propose",
    "inventory:stock:transfer",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type InvAiConfirmableAction = keyof typeof INV_AI_CONFIRMABLE_ACTIONS;

/**
 * The keys an action costs, or `null` for an action this module does not know
 * how to price.
 *
 * `null` is a deny, not a pass. An unrecognised action is one nobody has
 * decided the authority for, and the safe reading of "we never decided" is
 * "not allowed" — the alternative is that adding a proposal type silently
 * creates an ungated mutation.
 */
export function requiredPermissionsForAiAction(
  action: string,
): readonly string[] | null {
  return (
    (INV_AI_CONFIRMABLE_ACTIONS as Readonly<Record<string, readonly string[]>>)[
      action
    ] ?? null
  );
}

/**
 * Assert the caller holds every key the action costs.
 *
 * `ForbiddenException`, not `NotFoundException`: the caller is inside the
 * correct tenant and the record they are acting on is one they were handed a
 * token for. §4's existence-oracle rule is about another org's ids; this is the
 * case it explicitly reserves 403 for.
 *
 * Sequential rather than `Promise.all` on purpose — `AccessService.holds`
 * resolves from a per-`(userId, orgId)` cache, so the second call is a cache
 * hit, and short-circuiting means a caller missing the cheap key never pays for
 * the second lookup.
 */
export async function assertInvAiConfirmAuthority(
  access: Pick<AccessService, "holds">,
  user: CurrentUserContext,
  action: string,
): Promise<void> {
  const required = requiredPermissionsForAiAction(action);
  if (required === null) {
    throw new ForbiddenException("This proposal cannot be confirmed here");
  }

  for (const key of required) {
    if (!(await access.holds(user, key))) {
      throw new ForbiddenException("Permission denied");
    }
  }
}
