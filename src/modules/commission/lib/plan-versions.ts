import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  crmCommissionPlans,
  crmCommissionPlanVersions,
  type CommissionRuleSet,
} from "../../../db/schema/crm/commission";
import type { CreateVersionInput, UpdateVersionInput } from "../dto/commission.schemas";

/**
 * A plan's dated rule sets: the bodies of `CommissionService.createVersion`,
 * `updateVersion` and `resolveVersion`, whose docblocks state the dating model
 * these enforce — a version is never backdated, and never edited once sealed.
 */

/** The body of `CommissionService.createVersion`. */
export async function createPlanVersion(
  db: Db,
  orgId: string,
  planId: string,
  userId: string,
  input: CreateVersionInput,
) {
  return runInTenantTransaction(
    db,
    async (tx) => {
      const [plan] = await tx
        .select({
          planId: crmCommissionPlans.planId,
          retiredOn: crmCommissionPlans.retiredOn,
        })
        .from(crmCommissionPlans)
        .where(
          and(
            eq(crmCommissionPlans.orgId, orgId),
            eq(crmCommissionPlans.planId, planId),
          ),
        )
        .limit(1);
      if (!plan) throw new NotFoundException("Commission plan not found");
      if (plan.retiredOn)
        throw new ConflictException("This plan is retired; create a new plan instead");

      const [newest] = await tx
        .select({
          versionNumber: crmCommissionPlanVersions.versionNumber,
          effectiveFrom: crmCommissionPlanVersions.effectiveFrom,
        })
        .from(crmCommissionPlanVersions)
        .where(
          and(
            eq(crmCommissionPlanVersions.orgId, orgId),
            eq(crmCommissionPlanVersions.planId, planId),
          ),
        )
        .orderBy(desc(crmCommissionPlanVersions.versionNumber))
        .limit(1);

      if (newest && input.effectiveFrom <= newest.effectiveFrom)
        throw new ConflictException(
          `A new version must take effect after ${newest.effectiveFrom}; backdating would restate earnings already filed against the current version`,
        );

      const [version] = await tx
        .insert(crmCommissionPlanVersions)
        .values({
          orgId,
          planId,
          versionNumber: (newest?.versionNumber ?? 0) + 1,
          effectiveFrom: input.effectiveFrom,
          rules: input.rules as CommissionRuleSet,
          note: input.note ?? null,
          createdBy: userId,
        })
        .returning();
      return version;
    },
    { orgId },
  );
}

/** The body of `CommissionService.updateVersion`. */
export async function updatePlanVersion(
  db: Db,
  orgId: string,
  planId: string,
  planVersionId: string,
  input: UpdateVersionInput,
) {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.effectiveFrom !== undefined) patch.effectiveFrom = input.effectiveFrom;
  if (input.rules !== undefined) patch.rules = input.rules as CommissionRuleSet;
  if (input.note !== undefined) patch.note = input.note;

  const [updated] = await runInTenantTransaction(
    db,
    (tx) =>
      tx
        .update(crmCommissionPlanVersions)
        .set(patch)
        .where(
          and(
            eq(crmCommissionPlanVersions.orgId, orgId),
            eq(crmCommissionPlanVersions.planId, planId),
            eq(crmCommissionPlanVersions.planVersionId, planVersionId),
            isNull(crmCommissionPlanVersions.sealedAt),
          ),
        )
        .returning(),
    { orgId },
  );

  if (!updated) {
    const [existing] = await db
      .select({ sealedAt: crmCommissionPlanVersions.sealedAt })
      .from(crmCommissionPlanVersions)
      .where(
        and(
          eq(crmCommissionPlanVersions.orgId, orgId),
          eq(crmCommissionPlanVersions.planVersionId, planVersionId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Plan version not found");
    throw new ConflictException(
      "This version has already been earned against and cannot be changed. Create a new version instead.",
    );
  }
  return updated;
}

/** The body of `CommissionService.resolveVersion`. */
export async function resolvePlanVersion(db: Db, orgId: string, planId: string, on: string) {
  const [version] = await db
    .select()
    .from(crmCommissionPlanVersions)
    .where(
      and(
        eq(crmCommissionPlanVersions.orgId, orgId),
        eq(crmCommissionPlanVersions.planId, planId),
        lte(crmCommissionPlanVersions.effectiveFrom, on),
      ),
    )
    .orderBy(desc(crmCommissionPlanVersions.effectiveFrom))
    .limit(1);
  if (!version)
    throw new NotFoundException(
      `No commission plan version was in force on ${on}`,
    );
  return version;
}
