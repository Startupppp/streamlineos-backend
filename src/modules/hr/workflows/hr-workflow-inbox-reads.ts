import { and, desc, eq, lte, or } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  hrWorkflowDelegations,
  hrWorkflowInstances,
} from "../../../db/schema/hr/workflow-engine";
import {
  descKeyset,
  type DescKeysetPosition,
} from "../../../common/pagination/desc-keyset";

export const WORKFLOW_INBOX_OVERFETCH = 5;
export const WORKFLOW_INBOX_MAX_BATCHES = 5;

export type WorkflowInboxCandidate = {
  id: number;
  orgId: string;
  definitionId: number;
  objectType: string;
  objectId: string;
  requestedBy: string | null;
  subjectEmployeeId: string;
  context: typeof hrWorkflowInstances.$inferSelect.context;
  status: typeof hrWorkflowInstances.$inferSelect.status;
  currentStepOrder: number;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  definitionSnapshot: typeof hrWorkflowInstances.$inferSelect.definitionSnapshot;
};

export async function actingAndDelegatedMembershipIds(
  db: Db,
  orgId: string,
  membershipId: number,
): Promise<number[]> {
  const now = new Date();
  const delegations = await db
    .select({
      delegatorMembershipId: hrWorkflowDelegations.delegatorMembershipId,
      endsAt: hrWorkflowDelegations.endsAt,
    })
    .from(hrWorkflowDelegations)
    .where(
      and(
        eq(hrWorkflowDelegations.orgId, orgId),
        eq(hrWorkflowDelegations.delegateMembershipId, membershipId),
        eq(hrWorkflowDelegations.active, true),
        lte(hrWorkflowDelegations.startsAt, now),
      ),
    )
    .limit(50);

  return [
    membershipId,
    ...delegations
      .filter(
        (d): d is typeof d & { delegatorMembershipId: number } =>
          d.endsAt >= now && d.delegatorMembershipId != null,
      )
      .map((d) => d.delegatorMembershipId),
  ];
}

export async function readInboxCandidates(
  db: Db,
  orgId: string,
  limit: number,
  cursor: DescKeysetPosition | null,
  tieBreakById: boolean,
): Promise<WorkflowInboxCandidate[]> {
  return db
    .select({
      id: hrWorkflowInstances.id,
      orgId: hrWorkflowInstances.orgId,
      definitionId: hrWorkflowInstances.definitionId,
      objectType: hrWorkflowInstances.objectType,
      objectId: hrWorkflowInstances.objectId,
      requestedBy: hrWorkflowInstances.requestedBy,
      subjectEmployeeId: hrWorkflowInstances.subjectEmployeeId,
      context: hrWorkflowInstances.context,
      status: hrWorkflowInstances.status,
      currentStepOrder: hrWorkflowInstances.currentStepOrder,
      dueAt: hrWorkflowInstances.dueAt,
      createdAt: hrWorkflowInstances.createdAt,
      updatedAt: hrWorkflowInstances.updatedAt,
      definitionSnapshot: hrWorkflowInstances.definitionSnapshot,
    })
    .from(hrWorkflowInstances)
    .where(
      and(
        eq(hrWorkflowInstances.orgId, orgId),
        or(
          eq(hrWorkflowInstances.status, "in_progress"),
          eq(hrWorkflowInstances.status, "pending"),
        ),
        descKeyset(hrWorkflowInstances.createdAt, hrWorkflowInstances.id, cursor),
      ),
    )
    .orderBy(
      ...(tieBreakById
        ? [desc(hrWorkflowInstances.createdAt), desc(hrWorkflowInstances.id)]
        : [desc(hrWorkflowInstances.createdAt)]),
    )
    .limit(limit);
}
