import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { pendingApprovalsForActorCondition } from "../approvals/build-inbox-count.service";
import {
  commentDrafts,
  projectApprovals,
  projectMilestones,
  projectRisks,
  projects,
  ticketComments,
  tickets,
  workItemRelations,
} from "../../../db/schema";
import type { AgentPulseSignal } from "./dto/agent-pulse.schema";
import { COMMENT_DRAFT_MAX_RETRIES } from "../comment-drafts/comment-drafts.constants";
import { parseRecordIds } from "../comment-draft-record-ids";

const DEPENDENCY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const COMMENT_DRAFT_MIN_CONFIDENCE = 50;

interface AgentPulseScope {
  readonly projectId?: number;
  readonly managedProductId?: number;
  readonly pmWorkspaceId?: string;
}

@Injectable()
export class AgentPulseService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getTopSignal(
    orgId: string,
    userId: string,
    membershipId: number | null,
    scope: AgentPulseScope = {},
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const overdueApproval = await this.findOverdueApproval(orgId, membershipId, scope);
    if (overdueApproval !== null) return overdueApproval;

    const blockedMilestone = await this.findBlockedMilestone(orgId, membershipId, scope);
    if (blockedMilestone !== null) return blockedMilestone;

    const deliveryRisk = await this.findDeliveryRisk(orgId, userId, scope);
    if (deliveryRisk !== null) return deliveryRisk;

    const dependencyChange = await this.findDependencyChange(orgId, membershipId, scope);
    if (dependencyChange !== null) return dependencyChange;

    return this.findCommentDraft(orgId, membershipId, scope);
  }

  private async findOverdueApproval(
    orgId: string,
    membershipId: number | null,
    scope: AgentPulseScope,
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const now = new Date();
    const sel = {
      entityId: projectApprovals.id,
      projectId: projectApprovals.projectId,
      title: projectApprovals.title,
      dueAt: projectApprovals.dueAt,
    };
    const actorCond = and(
      pendingApprovalsForActorCondition(orgId, membershipId),
      lt(projectApprovals.dueAt, now),
    );

    if (scope.managedProductId !== undefined) {
      const [row] = await this.db.select(sel).from(projectApprovals)
        .innerJoin(projects, and(eq(projects.orgId, orgId), eq(projects.id, projectApprovals.projectId), eq(projects.managedProductId, scope.managedProductId), isNull(projects.deletedAt)))
        .where(actorCond).orderBy(asc(projectApprovals.dueAt), asc(projectApprovals.id)).limit(1);
      if (!row) return null;
      return { type: "overdue_approval", entityId: row.entityId, projectId: row.projectId, title: row.title, dueAt: row.dueAt?.toISOString() ?? null };
    }
    if (scope.pmWorkspaceId !== undefined) {
      const [row] = await this.db.select(sel).from(projectApprovals)
        .innerJoin(projects, and(eq(projects.orgId, orgId), eq(projects.id, projectApprovals.projectId), eq(projects.pmWorkspaceId, scope.pmWorkspaceId), isNull(projects.deletedAt)))
        .where(actorCond).orderBy(asc(projectApprovals.dueAt), asc(projectApprovals.id)).limit(1);
      if (!row) return null;
      return { type: "overdue_approval", entityId: row.entityId, projectId: row.projectId, title: row.title, dueAt: row.dueAt?.toISOString() ?? null };
    }
    const [row] = await this.db.select(sel).from(projectApprovals)
      .where(and(actorCond, scope.projectId !== undefined ? eq(projectApprovals.projectId, scope.projectId) : undefined))
      .orderBy(asc(projectApprovals.dueAt), asc(projectApprovals.id)).limit(1);
    if (!row) return null;
    return { type: "overdue_approval", entityId: row.entityId, projectId: row.projectId, title: row.title, dueAt: row.dueAt?.toISOString() ?? null };
  }

  private async findBlockedMilestone(
    orgId: string,
    membershipId: number | null,
    scope: AgentPulseScope,
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
          scope.projectId !== undefined ? eq(projects.id, scope.projectId) : undefined,
          scope.managedProductId !== undefined ? eq(projects.managedProductId, scope.managedProductId) : undefined,
          scope.pmWorkspaceId !== undefined ? eq(projects.pmWorkspaceId, scope.pmWorkspaceId) : undefined,
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
    scope: AgentPulseScope,
  ): Promise<AgentPulseSignal | null> {
    const sel = {
      entityId: projectRisks.id,
      projectId: projectRisks.projectId,
      title: projectRisks.title,
      createdAt: projectRisks.createdAt,
    };
    const riskCond = and(
      eq(projectRisks.orgId, orgId),
      eq(projectRisks.ownerId, userId),
      inArray(projectRisks.status, ["open", "mitigating"]),
      or(eq(projectRisks.probability, "high"), eq(projectRisks.impact, "high")),
      isNull(projectRisks.deletedAt),
      scope.projectId !== undefined ? eq(projectRisks.projectId, scope.projectId) : undefined,
    );

    if (scope.managedProductId !== undefined) {
      const [row] = await this.db.select(sel).from(projectRisks)
        .innerJoin(projects, and(eq(projects.orgId, orgId), eq(projects.id, projectRisks.projectId), eq(projects.managedProductId, scope.managedProductId), isNull(projects.deletedAt)))
        .where(riskCond).orderBy(asc(projectRisks.createdAt), asc(projectRisks.id)).limit(1);
      if (!row) return null;
      return { type: "delivery_risk", entityId: row.entityId, projectId: row.projectId, title: row.title, dueAt: null };
    }
    if (scope.pmWorkspaceId !== undefined) {
      const [row] = await this.db.select(sel).from(projectRisks)
        .innerJoin(projects, and(eq(projects.orgId, orgId), eq(projects.id, projectRisks.projectId), eq(projects.pmWorkspaceId, scope.pmWorkspaceId), isNull(projects.deletedAt)))
        .where(riskCond).orderBy(asc(projectRisks.createdAt), asc(projectRisks.id)).limit(1);
      if (!row) return null;
      return { type: "delivery_risk", entityId: row.entityId, projectId: row.projectId, title: row.title, dueAt: null };
    }
    const [row] = await this.db.select(sel).from(projectRisks)
      .where(riskCond).orderBy(asc(projectRisks.createdAt), asc(projectRisks.id)).limit(1);
    if (!row) return null;
    return { type: "delivery_risk", entityId: row.entityId, projectId: row.projectId, title: row.title, dueAt: null };
  }

  private async findDependencyChange(
    orgId: string,
    membershipId: number | null,
    scope: AgentPulseScope,
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const cutoff = new Date(Date.now() - DEPENDENCY_LOOKBACK_MS);
    const sel = {
      entityId: workItemRelations.workItemId,
      projectId: tickets.projectId,
      title: tickets.title,
      createdAt: workItemRelations.createdAt,
    };
    const ticketJoinCond = and(
      eq(tickets.orgId, orgId),
      eq(tickets.id, workItemRelations.workItemId),
      eq(tickets.assigneeMembershipId, membershipId),
      isNull(tickets.deletedAt),
      isNotNull(tickets.projectId),
      scope.projectId !== undefined ? eq(tickets.projectId, scope.projectId) : undefined,
    );
    const relCond = and(
      eq(workItemRelations.orgId, orgId),
      eq(workItemRelations.relationType, "blocked_by"),
      gt(workItemRelations.createdAt, cutoff),
    );

    if (scope.managedProductId !== undefined) {
      const [row] = await this.db.select(sel).from(workItemRelations)
        .innerJoin(tickets, ticketJoinCond)
        .innerJoin(projects, and(eq(projects.orgId, orgId), eq(projects.id, tickets.projectId), eq(projects.managedProductId, scope.managedProductId), isNull(projects.deletedAt)))
        .where(relCond).orderBy(asc(workItemRelations.createdAt), asc(workItemRelations.id)).limit(1);
      if (!row) return null;
      return { type: "dependency_change", entityId: row.entityId, projectId: row.projectId ?? 0, title: row.title, dueAt: null };
    }
    if (scope.pmWorkspaceId !== undefined) {
      const [row] = await this.db.select(sel).from(workItemRelations)
        .innerJoin(tickets, ticketJoinCond)
        .innerJoin(projects, and(eq(projects.orgId, orgId), eq(projects.id, tickets.projectId), eq(projects.pmWorkspaceId, scope.pmWorkspaceId), isNull(projects.deletedAt)))
        .where(relCond).orderBy(asc(workItemRelations.createdAt), asc(workItemRelations.id)).limit(1);
      if (!row) return null;
      return { type: "dependency_change", entityId: row.entityId, projectId: row.projectId ?? 0, title: row.title, dueAt: null };
    }
    const [row] = await this.db.select(sel).from(workItemRelations)
      .innerJoin(tickets, ticketJoinCond)
      .where(relCond).orderBy(asc(workItemRelations.createdAt), asc(workItemRelations.id)).limit(1);
    if (!row) return null;
    return { type: "dependency_change", entityId: row.entityId, projectId: row.projectId ?? 0, title: row.title, dueAt: null };
  }

  async applyDraft(
    orgId: string,
    userId: string,
    membershipId: number | null,
    draftId: number,
  ): Promise<{ commentId: number; ticketId: number }> {
    if (membershipId === null) throw new ForbiddenException("Organization membership required");

    const [draft] = await this.db
      .select({ id: commentDrafts.id, ticketId: commentDrafts.ticketId, body: commentDrafts.body })
      .from(commentDrafts)
      .where(and(
        eq(commentDrafts.id, draftId),
        eq(commentDrafts.orgId, orgId),
        eq(commentDrafts.membershipId, membershipId),
      ))
      .limit(1);

    if (!draft) throw new NotFoundException("Draft not found");

    const [ticket] = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, draft.ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
      .limit(1);

    if (!ticket) throw new NotFoundException("Ticket not found");

    const commentId = await this.db.transaction(async (tx) => {
      const [comment] = await tx
        .insert(ticketComments)
        .values({ orgId, ticketId: draft.ticketId, userId, content: draft.body })
        .returning({ id: ticketComments.id });
      if (!comment) throw new Error("Comment insert returned no rows");
      await tx
        .delete(commentDrafts)
        .where(and(
          eq(commentDrafts.id, draftId),
          eq(commentDrafts.orgId, orgId),
          eq(commentDrafts.membershipId, membershipId),
        ));
      return comment.id;
    });

    return { commentId, ticketId: draft.ticketId };
  }

  async countPendingSignals(orgId: string, membershipId: number | null): Promise<number> {
    if (membershipId === null) return 0;
    const [row] = await this.db
      .select({ total: count() })
      .from(commentDrafts)
      .where(and(
        eq(commentDrafts.orgId, orgId),
        eq(commentDrafts.membershipId, membershipId),
        or(isNull(commentDrafts.confidence), gte(commentDrafts.confidence, COMMENT_DRAFT_MIN_CONFIDENCE)),
        or(isNull(commentDrafts.retryCount), lt(commentDrafts.retryCount, COMMENT_DRAFT_MAX_RETRIES)),
      ));
    return row?.total ?? 0;
  }

  private async findCommentDraft(
    orgId: string,
    membershipId: number | null,
    scope: AgentPulseScope,
  ): Promise<AgentPulseSignal | null> {
    if (membershipId === null) return null;
    const sel = {
      entityId: commentDrafts.id,
      projectId: tickets.projectId,
      title: tickets.title,
      updatedAt: commentDrafts.updatedAt,
      evidence: commentDrafts.evidence,
      proposedChange: commentDrafts.proposedChange,
      impact: commentDrafts.impact,
      confidence: commentDrafts.confidence,
      affectedRecordIds: commentDrafts.affectedRecordIds,
      retryCount: commentDrafts.retryCount,
    };
    const ticketJoinCond = and(
      eq(tickets.orgId, orgId),
      eq(tickets.id, commentDrafts.ticketId),
      isNull(tickets.deletedAt),
      isNotNull(tickets.projectId),
      scope.projectId !== undefined ? eq(tickets.projectId, scope.projectId) : undefined,
    );
    const draftCond = and(
      eq(commentDrafts.orgId, orgId),
      eq(commentDrafts.membershipId, membershipId),
      or(isNull(commentDrafts.confidence), gte(commentDrafts.confidence, COMMENT_DRAFT_MIN_CONFIDENCE)),
      or(isNull(commentDrafts.retryCount), lt(commentDrafts.retryCount, COMMENT_DRAFT_MAX_RETRIES)),
    );

    if (scope.managedProductId !== undefined) {
      const [row] = await this.db.select(sel).from(commentDrafts)
        .innerJoin(tickets, ticketJoinCond)
        .innerJoin(projects, and(eq(projects.orgId, orgId), eq(projects.id, tickets.projectId), eq(projects.managedProductId, scope.managedProductId), isNull(projects.deletedAt)))
        .where(draftCond).orderBy(asc(commentDrafts.updatedAt), asc(commentDrafts.id)).limit(1);
      if (!row) return null;
      return { type: "comment_draft", entityId: row.entityId, projectId: row.projectId ?? 0, title: row.title, dueAt: null, evidence: row.evidence ?? null, proposedChange: row.proposedChange ?? null, impact: row.impact ?? null, confidence: row.confidence ?? null, affectedRecordIds: parseRecordIds(row.affectedRecordIds), retryCount: row.retryCount ?? 0 };
    }
    if (scope.pmWorkspaceId !== undefined) {
      const [row] = await this.db.select(sel).from(commentDrafts)
        .innerJoin(tickets, ticketJoinCond)
        .innerJoin(projects, and(eq(projects.orgId, orgId), eq(projects.id, tickets.projectId), eq(projects.pmWorkspaceId, scope.pmWorkspaceId), isNull(projects.deletedAt)))
        .where(draftCond).orderBy(asc(commentDrafts.updatedAt), asc(commentDrafts.id)).limit(1);
      if (!row) return null;
      return { type: "comment_draft", entityId: row.entityId, projectId: row.projectId ?? 0, title: row.title, dueAt: null, evidence: row.evidence ?? null, proposedChange: row.proposedChange ?? null, impact: row.impact ?? null, confidence: row.confidence ?? null, affectedRecordIds: parseRecordIds(row.affectedRecordIds), retryCount: row.retryCount ?? 0 };
    }
    const [row] = await this.db.select(sel).from(commentDrafts)
      .innerJoin(tickets, ticketJoinCond)
      .where(draftCond).orderBy(asc(commentDrafts.updatedAt), asc(commentDrafts.id)).limit(1);
    if (!row) return null;
    return {
      type: "comment_draft",
      entityId: row.entityId,
      projectId: row.projectId ?? 0,
      title: row.title,
      dueAt: null,
      evidence: row.evidence ?? null,
      proposedChange: row.proposedChange ?? null,
      impact: row.impact ?? null,
      confidence: row.confidence ?? null,
      affectedRecordIds: parseRecordIds(row.affectedRecordIds),
      retryCount: row.retryCount ?? 0,
    };
  }
}
