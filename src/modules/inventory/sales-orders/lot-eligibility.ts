import { ForbiddenException } from "@nestjs/common";
import type { AccessService } from "../../access/access.service";
import type { InvNearExpiryPolicy } from "../stock-engine/stock-engine.types";

/**
 * D2 — four questions about a lot, kept apart.
 *
 * The allocator has confused these before, and each collapse was a real defect:
 *
 *   1. **May this lot go to a customer at all?** Status and hard expiry. A
 *      `RECALLED` lot is refused under every strategy and every setting — a
 *      recall is not a warning. This is the question `expiryReservationPolicy`
 *      answers.
 *   2. **May it go to *this* customer?** A supply agreement puts a floor under
 *      the remaining shelf life: 120 days on arrival, or the pallet comes back
 *      at our cost. That floor is per customer, it is a property of the
 *      contract rather than of the warehouse, and it removes lots from the
 *      candidate set. `../settings/min-shelf-life.ts` owns where the number lives.
 *   3. **Should it be chosen automatically?** Short-dated stock is physically
 *      fine and frequently rejected on arrival, so an organisation may want it
 *      taken last (`DEPRIORITIZE`) or not taken without a human (`BLOCK`).
 *   4. **In what order, among the ones that qualify?** FEFO, FIFO. The strategy
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
 *
 * (2) is the one that cannot be expressed as an order at all, and that is why
 * it exists. FEFO *worsens* a shelf-life guarantee rather than helping it: it
 * reaches for the lot closest to its date, which is precisely the one the
 * customer's receiving bay will refuse. Ordering can only decide which
 * acceptable lot goes first; it can never make an unacceptable one acceptable,
 * and it can never differ between two customers looking at the same shelf.
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days from today to the lot's date — what an override record snapshots.
 *
 * Negative for a lot already past its date, so "how short-dated was it" and "was
 * it in fact expired" are the same number rather than two fields that can
 * disagree. Both dates are midnight UTC, so the division is exact.
 */
export function daysRemaining(expiryDate: string, today = todayIso()): number {
  const then = Date.parse(`${expiryDate}T00:00:00.000Z`);
  const now = Date.parse(`${today}T00:00:00.000Z`);
  return Math.round((then - now) / MS_PER_DAY);
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
  | { kind: "REFUSED"; reason: "LOT_STATUS" | "EXPIRED" | "NEAR_EXPIRY" | "SHELF_LIFE" };

export interface EligibilityPolicy {
  /** `expiryReservationPolicy` — what to do with stock that has already expired. */
  readonly expiryPolicy: string;
  readonly nearExpiryPolicy: InvNearExpiryPolicy;
  readonly nearExpiryWindowDays: number;
  /**
   * D2 — the remaining shelf life this destination contracted for, in days.
   *
   * `0` and omitted both mean no floor, which is the answer for every allocation
   * with no customer behind it (a transfer, an internal consumption) as well as
   * for a customer who agreed to none.
   *
   * Optional deliberately: this field arrived after the three-verdict contract
   * was already in use, and making it required would turn every existing policy
   * literal into a compile error rather than leaving it at its previous
   * behaviour. The cost is that a future caller can forget it — which is why the
   * only two places that build a policy for a *customer* both resolve it through
   * `../settings/min-shelf-life.ts`, and why the end-to-end proof reserves
   * against a real order rather than asserting on this type.
   */
  readonly minShelfLifeDays?: number;
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

  const expired = lot.expiryDate !== null && lot.expiryDate <= today;
  if (policy.expiryPolicy === "BLOCK" && expired) {
    return { kind: "REFUSED", reason: "EXPIRED" };
  }

  // The customer's contracted floor, and it outranks the organisation's own
  // near-expiry preference: `DEPRIORITIZE` says "take it last", which is still
  // taking it, and a lot below the floor may not be taken at all. Checked before
  // the tiering for exactly that reason.
  const floorDays = policy.minShelfLifeDays ?? 0;
  if (
    floorDays > 0 &&
    lot.expiryDate !== null &&
    lot.expiryDate < nearExpiryHorizon(floorDays, today)
  ) {
    // An already-expired lot fails every positive floor, but "expired" is not a
    // judgement call and must not become overridable by way of the shelf-life
    // rule. Reached only when the organisation allows expired stock at all.
    return expired
      ? { kind: "REFUSED", reason: "EXPIRED" }
      : { kind: "REFUSED", reason: "SHELF_LIFE" };
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
  return verdict.reason === "NEAR_EXPIRY" || verdict.reason === "SHELF_LIFE";
}

/**
 * The vocabulary an override record is written in — which rule was set aside.
 *
 * Only the two judgement calls have a name here, because only those two can be
 * overridden; anything else has no override to describe.
 */
export type OverriddenRule = "NEAR_EXPIRY" | "SHELF_LIFE";

/** Which rule an override would be setting aside, or null if none can be. */
export function overriddenRule(verdict: LotVerdict): OverriddenRule | null {
  if (verdict.kind === "DEPRIORITIZED") return "NEAR_EXPIRY";
  if (verdict.kind !== "REFUSED") return null;
  if (verdict.reason === "NEAR_EXPIRY" || verdict.reason === "SHELF_LIFE") return verdict.reason;
  return null;
}

/** Why a refusal cannot be overridden, in words an operator can act on. */
export function refusalMessage(verdict: LotVerdict): string {
  if (verdict.kind !== "REFUSED") return "";
  if (verdict.reason === "LOT_STATUS")
    return "That lot is not active — a recalled, blocked or consumed lot cannot be allocated, with or without an override.";
  if (verdict.reason === "EXPIRED")
    return "That lot has expired. Expired stock is not an allocation decision; release or write it off instead.";
  if (verdict.reason === "SHELF_LIFE")
    return "That lot has fewer days left than the minimum shelf life agreed for this customer. An override with a reason can take it.";
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
