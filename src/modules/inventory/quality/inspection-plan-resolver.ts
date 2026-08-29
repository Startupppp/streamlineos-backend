import { ConflictException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import type { SamplingMethod } from "./inspection-plan-sampling";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What a receipt or a return needs to know about the rule governing a grain. */
export interface ResolvedInspectionPlan {
  planId: number;
  planCode: string;
  planVersionId: number;
  version: number;
  samplingMethod: SamplingMethod;
  sampleValue: string | null;
}

/** A type alias, not an interface: `tx.execute<T>` needs `T` assignable to
 *  `Record<string, unknown>`, and only an alias carries an implicit index
 *  signature. */
type ResolvedPlanRow = {
  variant_id: number;
  plan_id: number;
  plan_code: string;
  version_id: number;
  version: number;
  sampling_method: string;
  sample_value: string | null;
};

const SAMPLING_METHODS: readonly SamplingMethod[] = ["ALL", "PERCENTAGE", "FIXED_QUANTITY"];

function toSamplingMethod(value: string): SamplingMethod {
  const found = SAMPLING_METHODS.find((method) => method === value);
  if (!found) throw new ConflictException(`Unknown sampling method ${value}`);
  return found;
}

/**
 * D3 — the rule governing each of these variants, or nothing where no plan
 * covers one.
 *
 * A free function rather than a method, so the receipt path depends on the
 * lookup and not on the whole plan CRUD service; and one query rather than one
 * per variant, because a receipt has as many variants as it has lines.
 *
 * Specificity is derived from which scope column is set rather than from a
 * stored precedence, so it cannot disagree with the foreign keys: a variant plan
 * beats a product plan beats a category plan beats the organisation-wide one.
 * `DISTINCT ON` picks the winner in a single pass.
 *
 * A category plan covers the category a product names directly. It does **not**
 * walk the category tree: a recursive match is a different rule with a much
 * larger blast radius, and inventing it here would silently widen every plan
 * already written against a leaf category.
 */
export async function resolveInspectionPlans(
  tx: Tx,
  orgId: string,
  productVariantIds: readonly number[],
  trigger: "RECEIPT" | "RETURN",
): Promise<Map<number, ResolvedInspectionPlan>> {
  const resolved = new Map<number, ResolvedInspectionPlan>();
  const unique = [...new Set(productVariantIds)];
  if (unique.length === 0) return resolved;

  const triggerColumn =
    trigger === "RECEIPT" ? sql`pl.applies_on_receipt` : sql`pl.applies_on_return`;

  const rows = await tx.execute<ResolvedPlanRow>(sql`
    WITH scoped AS (
      SELECT pv.id AS variant_id, pv.product_id, p.category_id
        FROM inv_product_variants pv
        JOIN inv_products p ON p.org_id = pv.org_id AND p.id = pv.product_id
       WHERE pv.org_id = ${orgId}
         AND pv.id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
    )
    SELECT DISTINCT ON (s.variant_id)
           s.variant_id,
           pl.id       AS plan_id,
           pl.code     AS plan_code,
           ver.id      AS version_id,
           ver.version AS version,
           ver.sampling_method::text AS sampling_method,
           ver.sample_value::text    AS sample_value
      FROM scoped s
      JOIN inv_inspection_plans pl
        ON pl.org_id = ${orgId}
       AND pl.deleted_at IS NULL
       AND pl.is_active
       AND ${triggerColumn}
       AND (
            pl.product_variant_id = s.variant_id
         OR (pl.product_variant_id IS NULL AND pl.product_id = s.product_id)
         OR (pl.product_variant_id IS NULL AND pl.product_id IS NULL
             AND pl.category_id IS NOT NULL AND pl.category_id = s.category_id)
         OR (pl.product_variant_id IS NULL AND pl.product_id IS NULL AND pl.category_id IS NULL)
       )
      JOIN inv_inspection_plan_versions ver
        ON ver.org_id = pl.org_id AND ver.plan_id = pl.id AND ver.status = 'ACTIVE'
     ORDER BY s.variant_id,
              (pl.product_variant_id IS NOT NULL) DESC,
              (pl.product_id IS NOT NULL) DESC,
              (pl.category_id IS NOT NULL) DESC,
              pl.id DESC
  `);

  for (const row of rows) {
    resolved.set(Number(row.variant_id), {
      planId: Number(row.plan_id),
      planCode: String(row.plan_code),
      planVersionId: Number(row.version_id),
      version: Number(row.version),
      samplingMethod: toSamplingMethod(String(row.sampling_method)),
      sampleValue: row.sample_value === null ? null : String(row.sample_value),
    });
  }
  return resolved;
}
