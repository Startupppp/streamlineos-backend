import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { invProducts, invProductVariants } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { isUniqueViolation } from "../../../../common/db/postgres-error";

/**
 * Soft delete and its inverse.
 *
 * Separate from the hard delete next door because the precondition is the other
 * way round: a hard delete is refused by what DEPENDS on the product, and a
 * restore is refused by what has since taken its SKUs.
 */
export interface ProductArchiveDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: InventoryAuditService;
}

export async function archiveProduct(deps: ProductArchiveDeps, orgId: string, productId: number, userId: string) {
  const existing = await deps.db.query.invProducts.findFirst({
    where: and(
      eq(invProducts.id, productId),
      eq(invProducts.orgId, orgId),
      isNull(invProducts.deletedAt),
    ),
    columns: { id: true, status: true },
  });
  if (!existing) throw new NotFoundException("Product not found");

  const [updated] = await deps.db
    .update(invProducts)
    .set({ status: "INACTIVE", updatedAt: new Date() })
    .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)))
    .returning();

  await deps.audit.insert(deps.db, {
    orgId,
    actorUserId: userId,
    action: "product.archive",
    resourceType: "product",
    resourceId: String(productId),
    before: { status: existing.status },
    after: { status: "INACTIVE" },
  });

  await deps.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
  await deps.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
  return updated;
}

/**
 * A4. Bring a product back, from either way it could have gone away.
 *
 * This used to load its row with `deleted_at IS NULL`, so the one state it
 * could not find was the deleted one — a soft-deleted product answered 404 to
 * the endpoint whose entire purpose was to undo that. It also only flipped
 * `status` back to ACTIVE and never cleared `deleted_at`, so even if the row
 * had been found, the product would have stayed invisible to every read (they
 * all filter deleted rows) and to the SKU uniqueness index.
 *
 * Restoring the variants matters as much as the product: `deleteProduct` soft
 * deletes both, and a product whose variants are still deleted is a catalogue
 * entry nobody can order.
 *
 * B2. Restore used to write `status: "ACTIVE"` unconditionally, which made it
 * a laundry for the A4 demand gate: discontinue a SKU, sell it to zero, delete
 * it, restore it, and it is orderable again in two clicks that neither asked
 * for nor recorded a decision to un-retire it. So restore now undoes exactly
 * one step, and never invents a status it did not itself set:
 *
 *   - a soft-deleted row is un-deleted and keeps the status it had. Nothing
 *     had to be remembered for this: `deleteProduct` writes only `deleted_at`,
 *     so the `status` column already *is* the pre-delete state.
 *   - an archived row (INACTIVE, which is the only status `archiveProduct`
 *     writes) goes back to ACTIVE, because that pair is what the Restore
 *     control means on a product that is merely archived.
 *   - DISCONTINUED is never lifted here. Retiring a SKU is a decision, and
 *     its inverse is the same deliberate edit that made it — `updateProduct`
 *     takes `status` — not a button labelled "Restore".
 *
 * Archive-then-delete therefore takes two restores to get back to ACTIVE, one
 * per step, which is the point.
 */
export async function restoreProduct(deps: ProductArchiveDeps, orgId: string, productId: number, userId: string) {
  return deps.db.transaction(async (tx) => {
    const existing = await tx.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true, sku: true, status: true, deletedAt: true },
    });
    if (!existing) throw new NotFoundException("Product not found");

    if (existing.deletedAt !== null) {
      await assertRestorableSkus(deps, tx, orgId, productId, existing.sku);
    }

    // Un-deleting restores the row as it stood; only an archive is lifted.
    const status =
      existing.deletedAt === null && existing.status === "INACTIVE"
        ? "ACTIVE"
        : existing.status;

    // B1. The pre-checks above name the SKU that is in the way, but they are
    // still a read followed by a write: two concurrent restores, or two
    // deleted variants of this product that were given the same SKU while
    // both were deleted, reach the partial unique indexes anyway. An
    // unhandled 23505 is a 500 on an endpoint that has a 409 to give.
    try {
      const restoredVariants = await tx
        .update(invProductVariants)
        .set({ deletedAt: null })
        .where(and(
          eq(invProductVariants.productId, productId),
          eq(invProductVariants.orgId, orgId),
          isNotNull(invProductVariants.deletedAt),
        ))
        .returning({ id: invProductVariants.id });

      const [updated] = await tx
        .update(invProducts)
        .set({ status, deletedAt: null, updatedAt: new Date() })
        .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)))
        .returning();

      await deps.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "product.restore",
        resourceType: "product",
        resourceId: String(productId),
        before: {
          status: existing.status,
          deletedAt: existing.deletedAt?.toISOString() ?? null,
        },
        after: { status, deletedAt: null, variantsRestored: restoredVariants.length },
      });

      await deps.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
      await deps.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          "One of this product's SKUs has been taken since it was deleted. Change the SKU that now holds it, or give this product's SKU a new value, before restoring it.",
        );
      }
      throw err;
    }
  });
}

/**
 * Both live-SKU indexes, checked before the restore rather than after.
 *
 * SKU uniqueness is a partial index over live rows on each of `inv_products`
 * and `inv_product_variants`, so a deleted SKU is free for reuse — and reuse
 * is normally *why* the product was deleted. The product-level check has
 * always been here; the variant-level one was not, and the variants are
 * cleared with no check at all, so the ordinary sequence "delete P, create Q
 * reusing P's variant SKU, restore P" hit `uniq_inv_product_variants_org_sku_live`
 * and came back a 500 from an endpoint standing right next to a friendly 409.
 */
async function assertRestorableSkus(
  deps: ProductArchiveDeps,
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  orgId: string,
  productId: number,
  productSku: string,
): Promise<void> {
  const clash = await tx.query.invProducts.findFirst({
    where: and(
      eq(invProducts.orgId, orgId),
      eq(invProducts.sku, productSku),
      isNull(invProducts.deletedAt),
    ),
    columns: { id: true },
  });
  if (clash && clash.id !== productId) {
    throw new ConflictException(
      `SKU ${productSku} now belongs to another product. Change that product's SKU, or give this one a new SKU, before restoring it.`,
    );
  }

  const deletedVariants = await tx.query.invProductVariants.findMany({
    where: and(
      eq(invProductVariants.productId, productId),
      eq(invProductVariants.orgId, orgId),
      isNotNull(invProductVariants.deletedAt),
    ),
    columns: { sku: true },
  });
  if (deletedVariants.length === 0) return;

  const takenRows = await tx
    .select({ sku: invProductVariants.sku })
    .from(invProductVariants)
    .where(and(
      eq(invProductVariants.orgId, orgId),
      inArray(invProductVariants.sku, deletedVariants.map((v) => v.sku)),
      isNull(invProductVariants.deletedAt),
    ));
  if (takenRows.length > 0) {
    const taken = [...new Set(takenRows.map((row) => row.sku))].sort();
    throw new ConflictException(
      `Variant SKU ${taken.join(", ")} now belongs to another product. Change that variant's SKU, or give this product's variants new SKUs, before restoring it.`,
    );
  }
}
