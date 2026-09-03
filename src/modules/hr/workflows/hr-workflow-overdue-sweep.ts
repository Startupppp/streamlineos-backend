import { and, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { hrWorkflowInstances, hrWorkflowStepActions } from "../../../db/schema/hr/workflow-engine";
import { organizationMembers } from "../../../db/schema/common/auth";
import type { ResolvedStep } from "./hr-workflow-engine.types";

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

  for (const instance of overdueInstances) {
    const steps = (instance.definitionSnapshot as { steps: ResolvedStep[] }).steps;
    const currentStep = steps.find((s) => s.stepOrder === instance.currentStepOrder);
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
