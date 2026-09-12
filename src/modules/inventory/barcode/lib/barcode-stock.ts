import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { invLocations, invProductVariants, invStockLevels } from "../../../../db/schema";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * The two on-hand totals a barcode lookup shows, lifted out of
 * `inv-barcode.service.ts` verbatim. Neither touches anything else on the
 * service, so the db handle and the scope service arrive as parameters.
 *
 * On hand, **in the buildings this caller holds** — not across the estate.
 *
 * Both helpers sum `inv_stock_levels`, which is keyed on a location, so neither
 * can be scoped without joining `inv_locations` for its `warehouse_id`. That
 * join is the whole mechanism, and it is the same one
 * `KitService.availableByComponent` uses; if either helper ever loses it, the
 * number silently goes organisation-wide again and nothing fails.
 *
 * `inventory:warehouses:scope-all` (`SCOPE_ALL_PERMISSION`) resolves the scope
 * to `null` — unrestricted — so the org-wide total is still available to
 * whoever the org has granted it to. That is the cross-building enquiry, and it
 * is a grant, not a default.
 *
 * A caller assigned to no warehouse at all gets "0" without the query running,
 * matching `KitService.buildable`.
 *
 * On the objection that this is a worse answer for a picker hunting stock: the
 * org-wide number never answered that question either. "4 on hand" with no
 * building attached, to someone who then cannot find them on their own shelves,
 * is a number that misleads in exactly the case that matters. "0 here" is true.
 * Where it is in the estate is a different screen's answer, and it needs the
 * warehouse named alongside the quantity to be worth anything — which is why
 * widening *this* field was never the fix for it.
 */
export async function productStock(
  db: Db,
  warehouseScope: WarehouseScopeService,
  orgId: string,
  userId: string,
  productId: number,
): Promise<string> {
  const scope = await warehouseScope.resolve(orgId, userId);
  if (scope !== null && scope.length === 0) return "0";

  const result = await db
    .select({ total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')` })
    .from(invStockLevels)
    .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
    .innerJoin(
      invLocations,
      and(
        eq(invLocations.id, invStockLevels.locationId),
        eq(invLocations.orgId, invStockLevels.orgId),
      ),
    )
    .where(
      and(
        eq(invProductVariants.orgId, orgId),
        eq(invProductVariants.productId, productId),
        warehouseScope.warehousePredicate(scope, sql`${invLocations.warehouseId}`),
      ),
    );
  return result[0]?.total ?? "0";
}

/** Scoped for the reasons on `productStock` above. */
export async function variantStock(
  db: Db,
  warehouseScope: WarehouseScopeService,
  orgId: string,
  userId: string,
  variantId: number,
): Promise<string> {
  const scope = await warehouseScope.resolve(orgId, userId);
  if (scope !== null && scope.length === 0) return "0";

  const result = await db
    .select({ total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')` })
    .from(invStockLevels)
    .innerJoin(
      invLocations,
      and(
        eq(invLocations.id, invStockLevels.locationId),
        eq(invLocations.orgId, invStockLevels.orgId),
      ),
    )
    .where(
      and(
        eq(invStockLevels.orgId, orgId),
        eq(invStockLevels.productVariantId, variantId),
        warehouseScope.warehousePredicate(scope, sql`${invLocations.warehouseId}`),
      ),
    );
  return result[0]?.total ?? "0";
}
