import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import {
  getPostgresErrorCode,
  getPostgresErrorDetails,
} from "../../../common/db/postgres-error";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  crmCommissionAssignments,
  crmCommissionPlans,
  crmCommissionPlanVersions,
  type CommissionRuleSet,
} from "../../../db/schema/crm/commission";
import type {
  AssignInput,
  CreatePlanInput,
  EndAssignmentInput,
  UpdatePlanInput,
} from "../dto/commission.schemas";

/**
 * Plans and who is on them: the bodies of `CommissionService.createPlan`,
 * `getPlan`, `updatePlan`, `assign` and `endAssignment`, whose docblocks state
 * the contracts. Nothing here changes what anybody is paid — that is a version,
 * and versions are `plan-versions.ts`.
 */

/** The body of `CommissionService.createPlan`. */
export async function createCommissionPlan(
  db: Db,
  orgId: string,
  userId: string,
  input: CreatePlanInput,
) {
  try {
    return await runInTenantTransaction(
      db,
      async (tx) => {
        const [plan] = await tx
          .insert(crmCommissionPlans)
          .values({
            orgId,
            name: input.name,
            description: input.description ?? null,
            currency: input.currency,
            createdBy: userId,
          })
          .returning();
        if (!plan) throw new ConflictException("Could not create the plan");

        const [version] = await tx
          .insert(crmCommissionPlanVersions)
          .values({
            orgId,
            planId: plan.planId,
            versionNumber: 1,
            effectiveFrom: input.effectiveFrom,
            rules: input.rules as CommissionRuleSet,
            note: input.note ?? null,
            createdBy: userId,
          })
          .returning();

        return { plan, version };
      },
      { orgId },
    );
  } catch (e: unknown) {
    // `uniq_crm_commission_plans_org_name` — (org_id, name), caller-supplied.
    // Read through the helper: Drizzle keeps the SQLSTATE on `.cause`, so
    // `e.code` was undefined and a duplicate plan name answered 500.
    if (getPostgresErrorCode(e) === "23505")
      throw new ConflictException(
        `A commission plan named "${input.name}" already exists`,
      );
    throw e;
  }
}

/** The body of `CommissionService.getPlan`. */
export async function readCommissionPlan(db: Db, orgId: string, planId: string) {
  const [plan] = await db
    .select()
    .from(crmCommissionPlans)
    .where(
      and(eq(crmCommissionPlans.orgId, orgId), eq(crmCommissionPlans.planId, planId)),
    )
    .limit(1);
  if (!plan) throw new NotFoundException("Commission plan not found");

  const [versions, assignments] = await Promise.all([
    db
      .select()
      .from(crmCommissionPlanVersions)
      .where(
        and(
          eq(crmCommissionPlanVersions.orgId, orgId),
          eq(crmCommissionPlanVersions.planId, planId),
        ),
      )
      .orderBy(desc(crmCommissionPlanVersions.effectiveFrom))
      .limit(200),
    db
      .select()
      .from(crmCommissionAssignments)
      .where(
        and(
          eq(crmCommissionAssignments.orgId, orgId),
          eq(crmCommissionAssignments.planId, planId),
        ),
      )
      .orderBy(desc(crmCommissionAssignments.effectiveFrom))
      .limit(500),
  ]);

  return { plan, versions, assignments };
}

/** The body of `CommissionService.updatePlan`. */
export async function updateCommissionPlan(
  db: Db,
  orgId: string,
  planId: string,
  input: UpdatePlanInput,
) {
  const [updated] = await runInTenantTransaction(
    db,
    (tx) =>
      tx
        .update(crmCommissionPlans)
        .set({ ...input, updatedAt: new Date() })
        .where(
          and(
            eq(crmCommissionPlans.orgId, orgId),
            eq(crmCommissionPlans.planId, planId),
          ),
        )
        .returning(),
    { orgId },
  );
  if (!updated) throw new NotFoundException("Commission plan not found");
  return updated;
}

/** The body of `CommissionService.assign`. */
export async function assignToPlan(db: Db, orgId: string, planId: string, input: AssignInput) {
  try {
    return await runInTenantTransaction(
      db,
      async (tx) => {
        const [plan] = await tx
          .select({ retiredOn: crmCommissionPlans.retiredOn })
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
          throw new ConflictException("This plan is retired and takes no new members");

        const [assignment] = await tx
          .insert(crmCommissionAssignments)
          .values({
            orgId,
            planId,
            userId: input.userId,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
            quotaOverrideMinor: input.quotaOverrideMinor,
          })
          .returning();
        return assignment;
      },
      { orgId },
    );
  } catch (e: unknown) {
    /**
     * Two indexes reach here and they mean different things, so the message
     * says which one answered rather than guessing:
     * `uniq_crm_commission_assignments_open` — (org_id, user_id) WHERE
     * effective_to IS NULL — is the open-assignment rule the old text named,
     * and `uniq_crm_commission_assignments_start` — (org_id, user_id,
     * effective_from) — is a second assignment starting on a day one already
     * starts on, which the old text described wrongly.
     */
    const { code, constraint } = getPostgresErrorDetails(e);
    if (code === "23505")
      throw new ConflictException(
        constraint === "uniq_crm_commission_assignments_start"
          ? `This person already has a commission assignment starting on ${input.effectiveFrom}`
          : "This person already has an open commission assignment; end it before starting another",
      );
    throw e;
  }
}

/** The body of `CommissionService.endAssignment`. */
export async function endPlanAssignment(
  db: Db,
  orgId: string,
  assignmentId: string,
  input: EndAssignmentInput,
) {
  const [updated] = await runInTenantTransaction(
    db,
    (tx) =>
      tx
        .update(crmCommissionAssignments)
        .set({ effectiveTo: input.effectiveTo, updatedAt: new Date() })
        .where(
          and(
            eq(crmCommissionAssignments.orgId, orgId),
            eq(crmCommissionAssignments.assignmentId, assignmentId),
            gte(sql`${input.effectiveTo}::date`, crmCommissionAssignments.effectiveFrom),
          ),
        )
        .returning(),
    { orgId },
  );
  if (!updated)
    throw new NotFoundException(
      "Assignment not found, or the end date precedes its start",
    );
  return updated;
}
