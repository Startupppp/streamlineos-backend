import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { pendingApprovalsForActorCondition } from "../approvals/build-inbox-count.service";
import {
  commentDrafts,
  projectApprovals,
  projectMilestones,
  projectRisks,
  projects,
  tickets,
  workItemRelations,
} from "../../../db/schema";
import type { AgentPulseSignal } from "./dto/agent-pulse.schema";

const DEPENDENCY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AgentPulseService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getTopSignal(
    orgId: string,
    userId: string,
    membershipId: number | null,
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const overdueApproval = await this.findOverdueApproval(orgId, membershipId);
    if (overdueApproval !== null) return overdueApproval;

    const blockedMilestone = await this.findBlockedMilestone(orgId, membershipId);
    if (blockedMilestone !== null) return blockedMilestone;

    const deliveryRisk = await this.findDeliveryRisk(orgId, userId);
    if (deliveryRisk !== null) return deliveryRisk;

    const dependencyChange = await this.findDependencyChange(orgId, membershipId);
    if (dependencyChange !== null) return dependencyChange;

    return this.findCommentDraft(orgId, membershipId);
  }

  private async findOverdueApproval(
    orgId: string,
    membershipId: number | null,
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const now = new Date();
    const [row] = await this.db
      .select({
        entityId: projectApprovals.id,
        projectId: projectApprovals.projectId,
        title: projectApprovals.title,
        dueAt: projectApprovals.dueAt,
      })
      .from(projectApprovals)
      .where(
        and(
          pendingApprovalsForActorCondition(orgId, membershipId),
          lt(projectApprovals.dueAt, now),
        ),
      )
      .orderBy(asc(projectApprovals.dueAt), asc(projectApprovals.id))
      .limit(1);

    if (!row) return null;
    return {
      type: "overdue_approval",
      entityId: row.entityId,
      projectId: row.projectId,
      title: row.title,
      dueAt: row.dueAt?.toISOString() ?? null,
    };
  }

  private async findBlockedMilestone(
    orgId: string,
    membershipId: number | null,
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await this.db
      .select({
        entityId: projectMilestones.id,
        projectId: projectMilestones.projectId,
        title: projectMilestones.name,
        targetDate: projectMilestones.targetDate,
      })
      .from(projectMilestones)
      .innerJoin(
        projects,
        and(
          eq(projects.orgId, orgId),
          eq(projects.id, projectMilestones.projectId),
          eq(projects.managerMembershipId, membershipId),
          isNull(projects.deletedAt),
        ),
      )
      .where(
        and(
          eq(projectMilestones.orgId, orgId),
          eq(projectMilestones.status, "PENDING"),
          lt(projectMilestones.targetDate, today),
          isNull(projectMilestones.deletedAt),
        ),
      )
      .orderBy(asc(projectMilestones.targetDate), asc(projectMilestones.id))
      .limit(1);

    if (!row) return null;
    return {
      type: "blocked_milestone",
      entityId: row.entityId,
      projectId: row.projectId,
      title: row.title,
      dueAt: row.targetDate,
    };
  }

  private async findDeliveryRisk(
    orgId: string,
    userId: string,
  ): Promise<AgentPulseSignal | null> {
    const [row] = await this.db
      .select({
        entityId: projectRisks.id,
        projectId: projectRisks.projectId,
        title: projectRisks.title,
        createdAt: projectRisks.createdAt,
      })
      .from(projectRisks)
      .where(
        and(
          eq(projectRisks.orgId, orgId),
          eq(projectRisks.ownerId, userId),
          inArray(projectRisks.status, ["open", "mitigating"]),
          or(
            eq(projectRisks.probability, "high"),
            eq(projectRisks.impact, "high"),
          ),
          isNull(projectRisks.deletedAt),
        ),
      )
      .orderBy(asc(projectRisks.createdAt), asc(projectRisks.id))
      .limit(1);

    if (!row) return null;
    return {
      type: "delivery_risk",
      entityId: row.entityId,
      projectId: row.projectId,
      title: row.title,
      dueAt: null,
    };
  }

  private async findDependencyChange(
    orgId: string,
    membershipId: number | null,
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const cutoff = new Date(Date.now() - DEPENDENCY_LOOKBACK_MS);
    const [row] = await this.db
      .select({
        entityId: workItemRelations.workItemId,
        projectId: tickets.projectId,
        title: tickets.title,
        createdAt: workItemRelations.createdAt,
      })
      .from(workItemRelations)
      .innerJoin(
        tickets,
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.id, workItemRelations.workItemId),
          eq(tickets.assigneeMembershipId, membershipId),
          isNull(tickets.deletedAt),
          isNotNull(tickets.projectId),
        ),
      )
      .where(
        and(
          eq(workItemRelations.orgId, orgId),
          eq(workItemRelations.relationType, "blocked_by"),
          gt(workItemRelations.createdAt, cutoff),
        ),
      )
      .orderBy(asc(workItemRelations.createdAt), asc(workItemRelations.id))
      .limit(1);

    if (!row) return null;
    return {
      type: "dependency_change",
      entityId: row.entityId,
      projectId: row.projectId ?? 0,
      title: row.title,
      dueAt: null,
    };
  }

  private async findCommentDraft(
    orgId: string,
    membershipId: number | null,
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const [row] = await this.db
      .select({
        entityId: commentDrafts.id,
        projectId: tickets.projectId,
        title: tickets.title,
        updatedAt: commentDrafts.updatedAt,
      })
      .from(commentDrafts)
      .innerJoin(
        tickets,
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.id, commentDrafts.ticketId),
          isNull(tickets.deletedAt),
          isNotNull(tickets.projectId),
        ),
      )
      .where(
        and(
          eq(commentDrafts.orgId, orgId),
          eq(commentDrafts.membershipId, membershipId),
        ),
      )
      .orderBy(asc(commentDrafts.updatedAt), asc(commentDrafts.id))
      .limit(1);

    if (!row) return null;
    return {
      type: "comment_draft",
      entityId: row.entityId,
      projectId: row.projectId ?? 0,
      title: row.title,
      dueAt: null,
    };
  }
}
