import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import { crmPipelineStages } from "../../../db/schema/crm/metadata";
import {
  crmCommissionAssignments,
  crmCommissionEarnings,
} from "../../../db/schema/crm/commission";

/**
 * The three reads an earning is priced from, each inside the calculation's own
 * transaction: the assignment in force on the close date, the basis already
 * earned in that period, and the stages this tenant counts as won.
 */

/** The assignment covering a date; null when the person was on no plan then. */
export async function assignmentOn(tx: TenantTx, orgId: string, userId: string, on: string) {
  const [assignment] = await tx
    .select()
    .from(crmCommissionAssignments)
    .where(
      and(
        eq(crmCommissionAssignments.orgId, orgId),
        eq(crmCommissionAssignments.userId, userId),
        lte(crmCommissionAssignments.effectiveFrom, on),
        or(
          isNull(crmCommissionAssignments.effectiveTo),
          gte(crmCommissionAssignments.effectiveTo, on),
        ),
      ),
    )
    .orderBy(desc(crmCommissionAssignments.effectiveFrom))
    .limit(1);
  return assignment ?? null;
}

/**
 * Cumulative basis this earner has already booked in the window.
 *
 * `sum()` over a `bigint` column is `numeric`, which postgres-js hands back as
 * a string; `Number` on it is exact up to 2^53 minor units, which is ninety
 * trillion of any currency and past the point where a commission plan is the
 * problem. Coalesced because `sum()` over no rows is NULL, and NULL would
 * propagate into the evaluator as `NaN` and pay zero without failing.
 *
 * VOID rows are excluded and the deal itself is excluded, so a recalculation
 * of an existing earning walks the same bands it walked the first time.
 */
export async function attainmentToDate(
  tx: TenantTx,
  orgId: string,
  userId: string,
  planId: string,
  window: { start: string; end: string },
  excludeSourceId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${crmCommissionEarnings.basisMinor}), 0)`,
    })
    .from(crmCommissionEarnings)
    .where(
      and(
        eq(crmCommissionEarnings.orgId, orgId),
        eq(crmCommissionEarnings.userId, userId),
        eq(crmCommissionEarnings.planId, planId),
        gte(crmCommissionEarnings.earnedOn, window.start),
        lte(crmCommissionEarnings.earnedOn, window.end),
        ne(crmCommissionEarnings.status, "VOID"),
        ne(crmCommissionEarnings.sourceId, excludeSourceId),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * The stage keys the tenant treats as won.
 *
 * Resolved from the tenant's own pipeline metadata, with the same fallback
 * `crm-campaigns.service.ts` uses, so an organisation that never configured
 * pipelines still behaves. Hard-coding `"WON"` would silently pay nothing for
 * every tenant whose won stage is called something else.
 */
export async function wonStageKeys(tx: TenantTx, orgId: string): Promise<string[]> {
  const rows = await tx
    .select({ key: crmPipelineStages.key })
    .from(crmPipelineStages)
    .where(
      and(
        eq(crmPipelineStages.orgId, orgId),
        inArray(crmPipelineStages.stageType, ["won"]),
      ),
    );
  return rows.length ? rows.map((r) => r.key) : ["WON", "Closed Won"];
}
