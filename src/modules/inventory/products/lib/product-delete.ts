import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  invProducts,
  invProductVariants,
  invPurchaseOrders,
  invPoLines,
  invSalesOrders,
  invSoLines,
  invStockLevels,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";

export interface ProductDeleteDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: InventoryAuditService;
}

/**
 * Removes a product from the catalogue without destroying anything.
 *
 * This used to be a physical DELETE, and inv_stock_transactions.product_variant_id
 * carries ON DELETE CASCADE — so a product that was received and then fully
 * shipped nets to zero on hand, passes the stock guard below, and takes its
 * whole movement history with it, along with its lots, serials, valuation
 * layers and cost history. Proven in a rolled-back transaction: two ledger
 * rows and one lot before, zero of each after.
 *
 * Now it stamps deleted_at, so the ledger is unreachable by this path. The
 * conflict guards stay, because hiding a product that still holds stock or
 * sits on an open order is a mistake worth refusing rather than absorbing.
 */
export async function deleteProduct(deps: ProductDeleteDeps, orgId: string, productId: number, userId: string) {
  return deps.db.transaction(async (tx) => {
    const existing = await tx.query.invProducts.findFirst({
      where: and(
        eq(invProducts.id, productId),
        eq(invProducts.orgId, orgId),
        isNull(invProducts.deletedAt),
      ),
      columns: { id: true, sku: true, name: true },
    });
    if (!existing) throw new NotFoundException("Product not found");

    const variants = await tx.query.invProductVariants.findMany({
      where: and(
        eq(invProductVariants.productId, productId),
        eq(invProductVariants.orgId, orgId),
        isNull(invProductVariants.deletedAt),
      ),
      columns: { id: true },
    });

    if (variants.length > 0) {
      const variantIds = variants.map((v) => v.id);
      await assertNothingDependsOn(deps, tx, orgId, variantIds);
    }

    const deletedAt = new Date();
    await tx
      .update(invProducts)
      .set({ deletedAt })
      .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)));
    await tx
      .update(invProductVariants)
      .set({ deletedAt })
      .where(and(
        eq(invProductVariants.productId, productId),
        eq(invProductVariants.orgId, orgId),
        isNull(invProductVariants.deletedAt),
      ));

    await deps.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "product.deleted",
      resourceType: "product",
      resourceId: String(productId),
      before: { sku: existing.sku, name: existing.name, deletedAt: null },
      after: { deletedAt: deletedAt.toISOString(), variantsDeleted: variants.length },
    });

    await deps.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
    await deps.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
  });
}

/**
 * Refuses when the product still holds stock or sits on an open document.
 *
 * The quantity comparison is done in Postgres, not JavaScript: the previous
 * `parseFloat(sum) > 0` read an 18,4 numeric through a float, which is the one
 * arithmetic the PRD forbids outright for stock.
 */
async function assertNothingDependsOn(
  deps: ProductDeleteDeps,
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  orgId: string,
  variantIds: number[],
): Promise<void> {
    const [stockRows, openPoLines, openSoLines] = await Promise.all([
      tx
        .select({
          positive: sql<boolean>`COALESCE(SUM(${invStockLevels.onHand}), 0) > 0`,
        })
        .from(invStockLevels)
        .where(and(
          eq(invStockLevels.orgId, orgId),
          inArray(invStockLevels.productVariantId, variantIds),
        )),
      tx
        .select({ id: invPoLines.id })
        .from(invPoLines)
        .innerJoin(
          invPurchaseOrders,
          eq(invPoLines.poId, invPurchaseOrders.id),
        )
        .where(
          and(
            eq(invPurchaseOrders.orgId, orgId),
            inArray(invPoLines.productVariantId, variantIds),
            inArray(invPurchaseOrders.status, ["DRAFT", "SENT", "PARTIAL"]),
          ),
        )
        .limit(1),
      tx
        .select({ id: invSoLines.id })
        .from(invSoLines)
        .innerJoin(invSalesOrders, eq(invSoLines.soId, invSalesOrders.id))
        .where(
          and(
            eq(invSalesOrders.orgId, orgId),
            inArray(invSoLines.productVariantId, variantIds),
            inArray(invSalesOrders.status, ["DRAFT", "CONFIRMED"]),
          ),
        )
        .limit(1),
    ]);

    if (stockRows[0]?.positive === true) {
      throw new ConflictException(
        "Cannot delete product with existing stock. Archive it instead.",
      );
    }

    if (openPoLines.length > 0 || openSoLines.length > 0) {
      throw new ConflictException(
        "Cannot delete product referenced in open purchase or sales orders. Archive it instead.",
      );
    }
}
