import { and, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../../../common/logger/logger.service";
import type { Db } from "../../../db/drizzle.module";
import { hrWorkflowInstances, hrWorkflowStepActions } from "../../../db/schema/hr/workflow-engine";
import { organizationMembers } from "../../../db/schema/common/auth";
import type { ResolvedStep } from "./hr-workflow-engine.types";

/**
 * The slice of a stored step the escalation sweep actually reads.
 *
 * `definition_snapshot` is declared `{ steps: unknown[] }` — the elements are
 * whatever the workflow definition looked like when the instance started, which
 * may be several releases ago. The previous `as { steps: ResolvedStep[] }` did
 * not merely misdescribe that; it was unsound at runtime. A snapshot written
 * without a `steps` key made `steps.find(...)` throw `Cannot read properties of
 * undefined`, and because this runs as one cron pass over up to 100 instances,
 * a single malformed row took the whole sweep down and no workflow anywhere
 * escalated. Parsing instead lets that one instance be skipped, counted and
 * logged while the rest of the batch escalates.
 *
 * Deliberately NOT `.strict()`. Strictness is the right default where a parse
 * guards a WRITE and a dropped field would become a wrong-subject write, but
 * this is a read of three fields out of an eight-field stored step: a strict
 * object would reject every real snapshot in the table. Nothing parsed here is
 * ever written back — the escalation row is built from the instance columns and
 * the two approver fields below — so an unread extra key cannot become a silent
 * data loss. What must not drift is the three names, and `EscalationStep` below
 * pins those to the engine's own type at compile time.
 */
const escalationStepSchema = z.object({
  stepOrder: z.number(),
  escalationApproverType: z.string().nullish(),
  escalationApproverValue: z.string().nullish(),
});

/** The jsonb column as a whole. `steps` is required: a snapshot without one is
 * exactly the shape the old cast promised away and then crashed on. */
export const definitionSnapshotSchema = z.object({
  steps: z.array(escalationStepSchema),
});

/**
 * The conformance edge to the engine. This is an assignment, not an assertion:
 * if `ResolvedStep` renames `stepOrder` or either escalation field, the
 * annotation on `currentStep` below stops compiling instead of leaving this
 * sweep parsing keys that no longer exist and escalating nothing.
 */
type EscalationStep = Pick<
  ResolvedStep,
  "stepOrder" | "escalationApproverType" | "escalationApproverValue"
>;

export async function sweepOverdueWorkflowSteps(db: Db, orgId?: string) {
  const now = new Date();
  const whereClause = orgId
    ? and(
        eq(hrWorkflowInstances.orgId, orgId),
        eq(hrWorkflowInstances.status, "in_progress"),
        lte(hrWorkflowInstances.dueAt, now),
      )
    : and(
        eq(hrWorkflowInstances.status, "in_progress"),
        lte(hrWorkflowInstances.dueAt, now),
      );

  const overdueInstances = await db.select({
    id: hrWorkflowInstances.id,
    orgId: hrWorkflowInstances.orgId,
    currentStepOrder: hrWorkflowInstances.currentStepOrder,
    definitionSnapshot: hrWorkflowInstances.definitionSnapshot,
  })
    .from(hrWorkflowInstances)
    .where(whereClause)
    .limit(100);

  const actionValues: (typeof hrWorkflowStepActions.$inferInsert)[] = [];
  const escalatedIds: number[] = [];

  let unreadableSnapshots = 0;

  for (const instance of overdueInstances) {
    const snapshot = definitionSnapshotSchema.safeParse(instance.definitionSnapshot);
    if (!snapshot.success) {
      unreadableSnapshots += 1;
      continue;
    }

    const currentStep: EscalationStep | undefined = snapshot.data.steps.find(
      (step) => step.stepOrder === instance.currentStepOrder,
    );
    if (!currentStep?.escalationApproverType || !currentStep.escalationApproverValue) continue;

    actionValues.push({
      orgId: instance.orgId,
      instanceId: instance.id,
      stepOrder: instance.currentStepOrder,
      approverUserId: currentStep.escalationApproverValue,
      approverMembershipId: null,
      actedByUserId: currentStep.escalationApproverValue,
      actedByMembershipId: null,
      action: "escalated",
      comment: "Auto-escalated due to SLA breach",
    });
    escalatedIds.push(instance.id);
  }

  // Skipping is the safe behaviour, but a silent skip is not: an instance whose
  // snapshot no longer parses will never escalate again, and nothing else in the
  // system would say so.
  if (unreadableSnapshots > 0) {
    logger.warn("HR workflow overdue sweep skipped instances with an unreadable definition snapshot", {
      orgId: orgId ?? null,
      skipped: unreadableSnapshots,
      examined: overdueInstances.length,
    });
  }

  if (actionValues.length > 0) {
    const updatedAt = new Date();
    await db.transaction(async (tx) => {
      const escalationUsers = actionValues.map((value) => value.actedByUserId).filter((value): value is string => Boolean(value));
      const escalationMembers = escalationUsers.length > 0
        ? await tx.select({ userId: organizationMembers.userId, membershipId: organizationMembers.id, orgId: organizationMembers.orgId }).from(organizationMembers).where(and(orgId ? eq(organizationMembers.orgId, orgId) : undefined, inArray(organizationMembers.userId, escalationUsers))).limit(escalationUsers.length)
        : [];
      const escalationMembershipByUser = new Map(escalationMembers.map((member) => [`${member.orgId}:${member.userId}`, member.membershipId]));
      for (const value of actionValues) {
        const actionOrgId = overdueInstances.find((instance) => instance.id === value.instanceId)?.orgId;
        const membershipId = value.actedByUserId && actionOrgId
          ? escalationMembershipByUser.get(`${actionOrgId}:${value.actedByUserId}`) ?? null
          : null;
        value.actedByMembershipId = membershipId;
        value.approverMembershipId = membershipId;
      }
      await tx.insert(hrWorkflowStepActions).values(actionValues);
      await tx.update(hrWorkflowInstances)
        .set({ dueAt: undefined, updatedAt })
        .where(inArray(hrWorkflowInstances.id, escalatedIds));
    });
  }

  return { swept: overdueInstances.length };
}
