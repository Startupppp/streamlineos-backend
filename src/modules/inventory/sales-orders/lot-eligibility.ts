import { ForbiddenException } from "@nestjs/common";
import type { AccessService } from "../../access/access.service";
import type { InvNearExpiryPolicy } from "../stock-engine/stock-engine.types";

/**
 * D2 — three questions about a lot, kept apart.
 *
 * The allocator has confused these before, and each collapse was a real defect:
 *
 *   1. **May this lot go to a customer at all?** Status and hard expiry. A
 *      `RECALLED` lot is refused under every strategy and every setting — a
 *      recall is not a warning. This is the question `expiryReservationPolicy`
 *      answers.
 *   2. **Should it be chosen automatically?** Short-dated stock is physically
 *      fine and frequently rejected on arrival, so an organisation may want it
 *      taken last (`DEPRIORITIZE`) or not taken without a human (`BLOCK`). That
 *      is a *different* question from (1) and it is what this file adds.
 *   3. **In what order, among the ones that qualify?** FEFO, FIFO. The strategy
 *      orders what is already eligible; it never widens it. INV-402 was exactly
 *      this collapse — eligibility lived inside `if (strategy === "FEFO")`, so
 *      every other strategy fell through and shipped expired stock.
 *
 * The tension worth naming: FEFO wants the soonest-expiring lot *first*, and
 * near-expiry policy wants it *last*. They are not in conflict, because they
 * answer different questions — near-expiry sorts lots into tiers, and FEFO
 * orders within a tier. A warehouse running FEFO with `DEPRIORITIZE` ships its
 * oldest good stock first and only reaches the short-dated tier when there is
 * nothing else, which is what both settings were asked for.
 */

export const ALLOCATION_OVERRIDE_PERMISSION = "inventory:allocation:override";

export interface LotFacts {
  readonly expiryDate: string | null;
  readonly status: string;
}

/** Today, as the date strings in `inv_lots.expiry_date` are written. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The last day that still counts as near expiry, given a window in days. */
export function nearExpiryHorizon(windowDays: number, today = todayIso()): string {
  const horizon = new Date(`${today}T00:00:00.000Z`);
  horizon.setUTCDate(horizon.getUTCDate() + windowDays);
  return horizon.toISOString().slice(0, 10);
}

/**
 * Whether a lot is short-dated: not expired, but inside the window.
 *
 * A lot with no expiry date is never near expiry — it has no date to be near.
 */
export function isNearExpiry(
  lot: LotFacts | undefined,
  windowDays: number,
  today = todayIso(),
): boolean {
  if (!lot?.expiryDate) return false;
  if (lot.expiryDate <= today) return false;
  return lot.expiryDate <= nearExpiryHorizon(windowDays, today);
}

export type LotVerdict =
  /** Allocatable, and preferred. */
  | { kind: "ELIGIBLE" }
  /** Allocatable, but only once nothing in the first tier can cover the line. */
  | { kind: "DEPRIORITIZED"; reason: "NEAR_EXPIRY" }
  /** Not allocatable automatically. An override may still choose it, if the reason allows. */
  | { kind: "REFUSED"; reason: "LOT_STATUS" | "EXPIRED" | "NEAR_EXPIRY" };

export interface EligibilityPolicy {
  /** `expiryReservationPolicy` — what to do with stock that has already expired. */
  readonly expiryPolicy: string;
  readonly nearExpiryPolicy: InvNearExpiryPolicy;
  readonly nearExpiryWindowDays: number;
}

/**
 * The verdict on one lot, before any ordering.
 *
 * `lotId === null` is untracked stock and always eligible: there is no lot to
 * have a status or a date.
 */
export function verdictFor(
  lotId: number | null,
  lotById: ReadonlyMap<number, LotFacts>,
  policy: EligibilityPolicy,
  today = todayIso(),
): LotVerdict {
  if (lotId === null) return { kind: "ELIGIBLE" };

  const lot = lotById.get(lotId);
  // A lot id that resolves to nothing is not an untracked row — it is a
  // dangling reference, and promising stock against it would be promising
  // stock whose expiry nobody can check.
  if (!lot) return { kind: "REFUSED", reason: "LOT_STATUS" };

  // CONSUMED, BLOCKED, RECALLED and EXPIRED are refused whatever any policy
  // says. A recall is not a warning.
  if (lot.status !== "ACTIVE") return { kind: "REFUSED", reason: "LOT_STATUS" };

  if (policy.expiryPolicy === "BLOCK" && lot.expiryDate !== null && lot.expiryDate <= today) {
    return { kind: "REFUSED", reason: "EXPIRED" };
  }

  if (policy.nearExpiryPolicy !== "ALLOW" && isNearExpiry(lot, policy.nearExpiryWindowDays, today)) {
    return policy.nearExpiryPolicy === "BLOCK"
      ? { kind: "REFUSED", reason: "NEAR_EXPIRY" }
      : { kind: "DEPRIORITIZED", reason: "NEAR_EXPIRY" };
  }

  return { kind: "ELIGIBLE" };
}

/**
 * What an override may and may not reach.
 *
 * An override exists for the judgement calls: taking a short-dated lot a
 * customer has agreed to accept, or taking a lot FEFO would not have chosen.
 * It does **not** reach a recalled, blocked or consumed lot, and it does not
 * reach an expired one — those are not judgement calls, and a permission that
 * could wave them through would make `expiryReservationPolicy: BLOCK` a
 * suggestion. `inventory:quality:release` is the key that moves quarantined
 * stock, and it does so by changing the lot, not by allocating around it.
 */
export function overridable(verdict: LotVerdict): boolean {
  if (verdict.kind === "ELIGIBLE") return false;
  if (verdict.kind === "DEPRIORITIZED") return true;
  return verdict.reason === "NEAR_EXPIRY";
}

/** Why a refusal cannot be overridden, in words an operator can act on. */
export function refusalMessage(verdict: LotVerdict): string {
  if (verdict.kind !== "REFUSED") return "";
  if (verdict.reason === "LOT_STATUS")
    return "That lot is not active — a recalled, blocked or consumed lot cannot be allocated, with or without an override.";
  if (verdict.reason === "EXPIRED")
    return "That lot has expired. Expired stock is not an allocation decision; release or write it off instead.";
  return "That lot is inside the near-expiry window and this organisation blocks short-dated stock. An override with a reason can take it.";
}

/**
 * Throws unless this member may override the allocator's choice.
 *
 * Reads the same resolution `PermissionGuard` performs, for the reason
 * `assertMayCreatePurchaseOrder` does: the decorator states the rule at the
 * edge, and this states it where the lot is actually chosen — which is the
 * place a new caller cannot route around.
 */
export async function assertMayOverrideAllocation(
  access: AccessService,
  orgId: string,
  userId: string,
): Promise<void> {
  const permissions = await access.resolveUserPermissions(orgId, userId);
  if (!permissions.has(ALLOCATION_OVERRIDE_PERMISSION)) {
    throw new ForbiddenException(
      "Choosing a lot the allocator would not have needs inventory:allocation:override.",
    );
  }
}
