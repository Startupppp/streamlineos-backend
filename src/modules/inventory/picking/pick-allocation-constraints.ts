import type { Db } from "../../../db/drizzle.module";
import type { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { clientBehindSource, resolveShelfLifeFloor } from "../settings/min-shelf-life";
import type { EligibilityPolicy } from "../sales-orders/lot-eligibility";

/**
 * D2 — the constraints a pick-time allocation owes, resolved in one place.
 *
 * Four call sites in this module reach the allocator: creating a wave, confirming
 * a pick without a supplied bin, substituting a SKU, and re-allocating after an
 * exception. Every one of them passed six arguments and stopped at
 * `expiryPolicy`, so an allocation made through picking ran with neither the
 * near-expiry tier nor the customer's contracted shelf-life floor — while the
 * same allocation made through auto-reserve honoured both.
 *
 * That is not a cosmetic inconsistency. A picker's substitution could hand a
 * customer a lot that auto-reserve had refused minutes earlier for breaching
 * their supply agreement, and nothing would record that a rule had been set
 * aside, because from picking's point of view no rule existed.
 *
 * The fix is one resolver rather than four copies, for the reason the module
 * already learned once: `pick-allocation.ts` says a private second allocator is
 * how picking came to promise expired lots, because the copy predated the terms
 * that exclude them. Four hand-assembled constraint objects would be the same
 * mistake in a smaller shape — the next constraint would be added to three of
 * them.
 *
 * **The floor is per destination, not per organisation.** `minShelfLifeDays` is
 * a term of one customer's supply agreement, so it is resolved from the sales
 * order behind the line. A wave spans several orders and therefore several
 * customers, which is why this takes the source document rather than being
 * resolved once for the wave: the strictest floor for one customer must not
 * quietly apply to another's stock, and the other's must not be relaxed to it.
 */
export interface PickAllocationConstraints {
  nearExpiryPolicy: EligibilityPolicy["nearExpiryPolicy"];
  nearExpiryWindowDays: number;
  minShelfLifeDays: number;
}

/**
 * The constraints for one sales order's lines.
 *
 * `soId` may be null — a wave line can exist without one — in which case only the
 * organisation's own near-expiry policy applies. That is the honest answer: with
 * no destination there is no supply agreement to honour, and inventing a floor
 * would refuse stock nobody has objected to.
 */
export async function resolvePickConstraints(
  db: Db,
  settingsService: InventorySettingsService,
  orgId: string,
  soId: number | string | null,
): Promise<PickAllocationConstraints> {
  const settings = await settingsService.get(orgId);
  const clientId =
    soId === null
      ? null
      : await clientBehindSource(db, orgId, "inv_sales_order", String(soId));
  const floor = await resolveShelfLifeFloor(db, orgId, clientId);

  return {
    nearExpiryPolicy: settings.nearExpiryPolicy,
    nearExpiryWindowDays: settings.nearExpiryWindowDays,
    minShelfLifeDays: floor.days,
  };
}

/**
 * A per-order cache for a wave, which spans several orders.
 *
 * Resolving the floor per *line* would run two queries for every line of every
 * order in the wave, and the answer cannot differ within one order. Resolving it
 * once for the whole wave would be wrong in the other direction — see above.
 */
export function pickConstraintsResolver(
  db: Db,
  settingsService: InventorySettingsService,
  orgId: string,
): (soId: number | string | null) => Promise<PickAllocationConstraints> {
  const cache = new Map<string, Promise<PickAllocationConstraints>>();
  return (soId) => {
    const key = soId === null ? "" : String(soId);
    const hit = cache.get(key);
    if (hit) return hit;
    const resolved = resolvePickConstraints(db, settingsService, orgId, soId);
    cache.set(key, resolved);
    return resolved;
  };
}
