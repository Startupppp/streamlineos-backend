import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { invProductVariants, invProducts } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";

/**
 * INV-107 — the lifecycle gate on new demand.
 *
 * `DISCONTINUED` was accepted by the DTO, stored on the row, and then read by
 * nothing. A discontinued SKU could be sold, reserved and promised to a
 * customer exactly like a live one, which makes the status decorative and the
 * catalogue a set of suggestions.
 *
 * Existing demand is deliberately untouched. Discontinuing a product must not
 * retroactively invalidate orders already taken -- those goods still have to
 * ship, and the ledger still has to explain itself. The rule is only that no
 * *new* demand may name a SKU that is no longer sellable.
 *
 * The tenant predicate is here too. The caller this was extracted from looked
 * variants up by id alone, so a variant id belonging to another organisation
 * resolved to a row, and only RLS stood between that and a cross-tenant order
 * line. A missing variant reads as 404 rather than 403 for the usual reason: a
 * 403 on another tenant's id confirms the row exists.
 */

export interface OrderableVariant {
  id: number;
  /** The owning product, so a caller needing it does not re-query per line. */
  productId: number;
  sku: string;
  costPrice: string;
  sellingPrice: string;
}

type VariantRow = {
  id: number;
  productId: number;
  sku: string;
  costPrice: string;
  sellingPrice: string;
  variantActive: boolean | null;
  productStatus: string;
  productDeletedAt: Date | null;
};

/** Tenant-scoped load with the "no such variant here" check the callers share. */
async function loadVariants(
  db: Db,
  orgId: string,
  variantIds: readonly number[],
): Promise<VariantRow[]> {
  const wanted = [...new Set(variantIds)];
  if (wanted.length === 0) return [];

  const rows = await db
    .select({
      id: invProductVariants.id,
      productId: invProductVariants.productId,
      sku: invProductVariants.sku,
      costPrice: invProductVariants.costPrice,
      sellingPrice: invProductVariants.sellingPrice,
      variantActive: invProductVariants.isActive,
      productStatus: invProducts.status,
      productDeletedAt: invProducts.deletedAt,
    })
    .from(invProductVariants)
    .innerJoin(
      invProducts,
      and(
        eq(invProducts.orgId, invProductVariants.orgId),
        eq(invProducts.id, invProductVariants.productId),
      ),
    )
    .where(
      and(
        eq(invProductVariants.orgId, orgId),
        inArray(invProductVariants.id, wanted),
        isNull(invProductVariants.deletedAt),
      ),
    );

  const found = new Set(rows.map((row) => row.id));
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new NotFoundException(
      `No such product variant in this organization: ${missing.join(", ")}`,
    );
  }
  return rows;
}

function toMap(rows: readonly VariantRow[]): Map<number, OrderableVariant> {
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        productId: row.productId,
        sku: row.sku,
        costPrice: row.costPrice,
        sellingPrice: row.sellingPrice,
      },
    ]),
  );
}

/**
 * Reported together rather than one at a time: an operator fixing a twelve-line
 * order should not have to submit it twelve times to discover twelve problems.
 */
function refuse(blocked: ReadonlyArray<{ sku: string; reason: string }>, verb: string): never {
  const detail = blocked.map((b) => `${b.sku} (${b.reason})`).join(", ");
  throw new ConflictException(
    `These SKUs can no longer be ${verb}: ${detail}. Existing orders are unaffected.`,
  );
}

/**
 * The gate on **new demand** — selling, buying, moving between warehouses, and
 * reserving by hand. A retired SKU may not be promised to anyone, ordered from
 * a supplier, or shipped across the estate.
 */
export async function loadOrderableVariants(
  db: Db,
  orgId: string,
  variantIds: readonly number[],
): Promise<Map<number, OrderableVariant>> {
  const rows = await loadVariants(db, orgId, variantIds);

  const blocked = rows.flatMap((row) => {
    // The words match the actions that produce the states. `archiveProduct` sets
    // status INACTIVE and `deleteProduct` sets `deleted_at`, so calling a
    // deleted product "archived" and an archived one "inactive" told the
    // operator the opposite of which button had been pressed.
    const reason =
      row.productDeletedAt !== null
        ? "deleted"
        : row.productStatus === "DISCONTINUED"
          ? "discontinued"
          : row.productStatus === "INACTIVE"
            ? "archived"
            : row.variantActive === false
              ? "an inactive variant"
              : null;
    return reason === null ? [] : [{ sku: row.sku, reason }];
  });
  if (blocked.length > 0) refuse(blocked, "ordered");

  return toMap(rows);
}

/**
 * A4. The gate on **correcting the record** — stock adjustments, cycle-count
 * postings and opening balances.
 *
 * Deliberately weaker than the demand gate, and the difference is the point.
 * Discontinuing a product does not make the units on its shelf disappear:
 * writing them off, or correcting a count that found three more in a corner, is
 * exactly what an operator does with retired stock, and refusing it would leave
 * the record permanently unable to describe reality — the opposite of what a
 * lifecycle status is for.
 *
 * What it still refuses is a product that has been deleted from the catalogue.
 * `deleteProduct` refuses while any stock exists, so a deleted product holds
 * none; adjusting one upward would conjure stock for a product no read can see.
 */
export async function loadCorrectableVariants(
  db: Db,
  orgId: string,
  variantIds: readonly number[],
): Promise<Map<number, OrderableVariant>> {
  const rows = await loadVariants(db, orgId, variantIds);

  const blocked = rows.flatMap((row) =>
    row.productDeletedAt !== null ? [{ sku: row.sku, reason: "deleted" }] : [],
  );
  if (blocked.length > 0) refuse(blocked, "adjusted");

  return toMap(rows);
}
