import { inArray, sql } from "drizzle-orm";
import { invProductVariants, invProducts } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { CostingMethod } from "./valuation.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface VariantCosting {
  costingMethod: CostingMethod;
  standardCost: string | null;
}

export type CostingLookup = ReadonlyMap<number, VariantCosting>;

const DEFAULT_COSTING: VariantCosting = { costingMethod: "WEIGHTED_AVERAGE", standardCost: null };

export function costingFor(lookup: CostingLookup, productVariantId: number): VariantCosting {
  return lookup.get(productVariantId) ?? DEFAULT_COSTING;
}

/**
 * Resolves the costing method and effective standard cost for every variant in a
 * command in two queries, rather than one variant lookup per movement as the
 * previous per-layer fetch did.
 *
 * The effective standard is the newest `inv_standard_costs` row covering the
 * posting date; `inv_products.standard_cost` remains the fallback until its
 * readers move off it.
 */
export async function loadCostingContext(
  tx: Tx,
  orgId: string,
  productVariantIds: readonly number[],
  postingDate: string,
): Promise<CostingLookup> {
  const ids = Array.from(new Set(productVariantIds));
  const lookup = new Map<number, VariantCosting>();
  if (ids.length === 0) return lookup;

  const variants = await tx
    .select({
      variantId: invProductVariants.id,
      costingMethod: invProducts.costingMethod,
      productStandardCost: invProducts.standardCost,
    })
    .from(invProductVariants)
    .innerJoin(invProducts, sql`${invProducts.id} = ${invProductVariants.productId}`)
    .where(inArray(invProductVariants.id, ids));

  const effective = await tx.execute<{ product_variant_id: number; unit_cost: string }>(sql`
    SELECT DISTINCT ON (product_variant_id) product_variant_id, unit_cost
    FROM inv_standard_costs
    WHERE org_id = ${orgId}
      AND product_variant_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND effective_from <= ${postingDate}::date
      AND (effective_to IS NULL OR effective_to >= ${postingDate}::date)
    ORDER BY product_variant_id, effective_from DESC
  `);

  const effectiveByVariant = new Map<number, string>();
  for (const row of effective) effectiveByVariant.set(Number(row.product_variant_id), String(row.unit_cost));

  for (const v of variants) {
    lookup.set(v.variantId, {
      costingMethod: (v.costingMethod ?? "WEIGHTED_AVERAGE") as CostingMethod,
      standardCost: effectiveByVariant.get(v.variantId) ?? v.productStandardCost ?? null,
    });
  }

  return lookup;
}
