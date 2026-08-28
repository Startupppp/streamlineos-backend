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
  sku: string;
  costPrice: string;
  sellingPrice: string;
}

export async function loadOrderableVariants(
  db: Db,
  orgId: string,
  variantIds: readonly number[],
): Promise<Map<number, OrderableVariant>> {
  const wanted = [...new Set(variantIds)];
  if (wanted.length === 0) return new Map();

  const rows = await db
    .select({
      id: invProductVariants.id,
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

  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new NotFoundException(
      `No such product variant in this organization: ${missing.join(", ")}`,
    );
  }

  // Reported together rather than one at a time: an operator fixing a
  // twelve-line order should not have to submit it twelve times to discover
  // twelve problems.
  const blocked = rows.filter(
    (row) =>
      row.productDeletedAt !== null ||
      row.productStatus === "DISCONTINUED" ||
      row.productStatus === "INACTIVE" ||
      !row.variantActive,
  );
  if (blocked.length > 0) {
    const detail = blocked
      .map((row) => {
        const reason =
          row.productDeletedAt !== null
            ? "archived"
            : row.productStatus === "DISCONTINUED"
              ? "discontinued"
              : row.productStatus === "INACTIVE"
                ? "inactive"
                : "an inactive variant";
        return `${row.sku} (${reason})`;
      })
      .join(", ");
    throw new ConflictException(
      `These SKUs can no longer be ordered: ${detail}. Existing orders are unaffected.`,
    );
  }

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        sku: row.sku,
        costPrice: row.costPrice,
        sellingPrice: row.sellingPrice,
      },
    ]),
  );
}
