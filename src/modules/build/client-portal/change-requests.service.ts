import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { changeRequestAffectedItems, changeRequests } from "../../../db/schema";
import {
  buildCursorPage,
  decodeIntegerCursor,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeId,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess, escapeLike } from "../core";
import type {
  CreateChangeRequestInput,
  ListCrQuery,
  UpdateChangeRequestInput,
} from "./dto/change-requests.schemas";
import { nextChangeRequestNumber } from "./change-request-number-counter";

const ALLOWED_TRANSITIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  submitted: ["under_review", "rejected"],
  under_review: ["estimated", "rejected", "submitted"],
  estimated: ["awaiting_approval", "rejected", "under_review"],
  awaiting_approval: ["approved", "rejected"],
  approved: ["in_progress"],
  in_progress: ["completed"],
  completed: [],
  rejected: ["submitted"],
};

const crColumns = {
  id: changeRequests.id,
  orgId: changeRequests.orgId,
  projectId: changeRequests.projectId,
  crNumber: changeRequests.crNumber,
  title: changeRequests.title,
  description: changeRequests.description,
  impact: changeRequests.impact,
  estimateMinutes: changeRequests.estimateMinutes,
  budgetImpactCents: changeRequests.budgetImpactCents,
  timelineImpactDays: changeRequests.timelineImpactDays,
  status: changeRequests.status,
  requestedById: changeRequests.requestedById,
  approvalOwnerId: changeRequests.approvalOwnerId,
  approvalOwnerMembershipId: changeRequests.approvalOwnerMembershipId,
  decisionComment: changeRequests.decisionComment,
  decidedAt: changeRequests.decidedAt,
  releaseId: changeRequests.releaseId,
  clientVisible: changeRequests.clientVisible,
  createdBy: changeRequests.createdBy,
  createdAt: changeRequests.createdAt,
  updatedAt: changeRequests.updatedAt,
  deletedAt: changeRequests.deletedAt,
};

const affectedItemCount = sql<number>`CAST(
  (SELECT COUNT(*)
   FROM ${changeRequestAffectedItems}
   WHERE ${changeRequestAffectedItems.orgId} = ${changeRequests.orgId}
     AND ${changeRequestAffectedItems.changeRequestId} = ${changeRequests.id})
  AS INT)`;

@Injectable()
export class ChangeRequestsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async listChangeRequests(u: CurrentUserContext, projectId: number, query: ListCrQuery) {
    const { orgId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    const limit = query.limit ?? 25;
    const position = decodeIntegerCursor(query.cursor ?? null);
    const rows = await this.db
      .select({
        id: changeRequests.id,
        orgId: changeRequests.orgId,
        projectId: changeRequests.projectId,
        crNumber: changeRequests.crNumber,
        title: changeRequests.title,
        description: changeRequests.description,
        impact: changeRequests.impact,
        estimateMinutes: changeRequests.estimateMinutes,
        budgetImpactCents: changeRequests.budgetImpactCents,
        timelineImpactDays: changeRequests.timelineImpactDays,
        status: changeRequests.status,
        requestedById: changeRequests.requestedById,
        approvalOwnerId: changeRequests.approvalOwnerId,
        approvalOwnerMembershipId: changeRequests.approvalOwnerMembershipId,
        decisionComment: changeRequests.decisionComment,
        decidedAt: changeRequests.decidedAt,
        releaseId: changeRequests.releaseId,
        clientVisible: changeRequests.clientVisible,
        createdBy: changeRequests.createdBy,
        createdAt: microsecondCursorValue(changeRequests.createdAt),
        updatedAt: changeRequests.updatedAt,
        deletedAt: changeRequests.deletedAt,
        affectedItemCount,
      })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.orgId, orgId),
          eq(changeRequests.projectId, projectId),
          isNull(changeRequests.deletedAt),
          query.status !== undefined ? eq(changeRequests.status, query.status) : undefined,
          query.impact !== undefined ? eq(changeRequests.impact, query.impact) : undefined,
          query.requesterId !== undefined
            ? eq(changeRequests.requestedById, query.requesterId)
            : undefined,
          query.approverId !== undefined
            ? eq(changeRequests.approvalOwnerId, query.approverId)
            : undefined,
          query.releaseId !== undefined
            ? eq(changeRequests.releaseId, query.releaseId)
            : undefined,
          query.clientVisible !== undefined
            ? eq(changeRequests.clientVisible, query.clientVisible)
            : undefined,
          query.q !== undefined
            ? ilike(changeRequests.title, `${escapeLike(query.q)}%`)
            : undefined,
          query.affectedTicketId !== undefined
            ? sql`EXISTS (
                SELECT 1
                FROM ${changeRequestAffectedItems}
                WHERE ${changeRequestAffectedItems.orgId} = ${orgId}
                  AND ${changeRequestAffectedItems.changeRequestId} = ${changeRequests.id}
                  AND ${changeRequestAffectedItems.ticketId} = ${query.affectedTicketId}
              )`
            : undefined,
          position
            ? keysetBeforeId(changeRequests.createdAt, changeRequests.id, position)
            : undefined,
        ),
      )
      .orderBy(desc(changeRequests.createdAt), desc(changeRequests.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt,
      id: String(row.id),
    }));
  }

  async getChangeRequest(u: CurrentUserContext, projectId: number, crId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [cr] = await this.db
      .select({ ...crColumns, affectedItemCount })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.id, crId),
          eq(changeRequests.orgId, u.orgId),
          eq(changeRequests.projectId, projectId),
          isNull(changeRequests.deletedAt),
        ),
      )
      .limit(1);
    if (!cr) throw new NotFoundException("Change request not found");
    return cr;
  }

  async createChangeRequest(
    u: CurrentUserContext,
    projectId: number,
    input: CreateChangeRequestInput,
  ) {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [cr] = await this.db.transaction(async (tx) => {
      const nextNumber = await nextChangeRequestNumber(tx, orgId, projectId);
      return tx
        .insert(changeRequests)
        .values({
          orgId,
          projectId,
          crNumber: nextNumber,
          title: input.title,
          description: input.description,
          impact: input.impact,
          estimateMinutes: input.estimateMinutes,
          budgetImpactCents: input.budgetImpactCents,
          timelineImpactDays: input.timelineImpactDays,
          releaseId: input.releaseId,
          clientVisible: input.clientVisible ?? false,
          status: "submitted",
          requestedById: userId,
          createdBy: userId,
        })
        .returning(crColumns);
    });
    this.audit.log({
      action: "change_request.created",
      userId,
      orgId,
      resourceType: "change_request",
      resourceId: String(cr.id),
      metadata: {
        crId: cr.id,
        projectId,
        crNumber: cr.crNumber,
        title: cr.title,
      },
    });
    return cr;
  }

  async updateChangeRequest(
    u: CurrentUserContext,
    projectId: number,
    crId: number,
    input: UpdateChangeRequestInput,
  ) {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [existing] = await this.db
      .select({
        id: changeRequests.id,
        status: changeRequests.status,
        requestedById: changeRequests.requestedById,
      })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.id, crId),
          eq(changeRequests.orgId, orgId),
          eq(changeRequests.projectId, projectId),
          isNull(changeRequests.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Change request not found");

    if (input.status !== undefined && input.status !== existing.status) {
      const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(input.status))
        throw new BadRequestException(
          `Status transition from '${existing.status}' to '${input.status}' is not permitted`,
        );
    }

    const isNewDecision =
      (input.status === "approved" || input.status === "rejected") &&
      input.status !== existing.status;
    const [updated] = await this.db
      .update(changeRequests)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.impact !== undefined && { impact: input.impact }),
        ...(input.estimateMinutes !== undefined && {
          estimateMinutes: input.estimateMinutes,
        }),
        ...(input.budgetImpactCents !== undefined && {
          budgetImpactCents: input.budgetImpactCents,
        }),
        ...(input.timelineImpactDays !== undefined && {
          timelineImpactDays: input.timelineImpactDays,
        }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.approvalOwnerId !== undefined && {
          approvalOwnerId: input.approvalOwnerId,
        }),
        ...(input.decisionComment !== undefined && {
          decisionComment: input.decisionComment,
        }),
        ...(input.releaseId !== undefined && { releaseId: input.releaseId }),
        ...(input.clientVisible !== undefined && {
          clientVisible: input.clientVisible,
        }),
        ...(isNewDecision && {
          decidedAt: new Date(),
          approvalOwnerId: input.approvalOwnerId ?? userId,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(changeRequests.id, crId),
          eq(changeRequests.orgId, orgId),
          eq(changeRequests.projectId, projectId),
          isNull(changeRequests.deletedAt),
        ),
      )
      .returning(crColumns);
    if (!updated) throw new NotFoundException("Change request not found");
    if (input.status !== undefined && input.status !== existing.status) {
      this.audit.log({
        action: "change_request.status_changed",
        userId,
        orgId,
        resourceType: "change_request",
        resourceId: String(crId),
        metadata: {
          crId,
          projectId,
          from: existing.status,
          to: input.status,
        },
      });
    }
    return updated;
  }

  async deleteChangeRequest(
    u: CurrentUserContext,
    projectId: number,
    crId: number,
  ): Promise<void> {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [existing] = await this.db
      .select({ id: changeRequests.id })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.id, crId),
          eq(changeRequests.orgId, orgId),
          eq(changeRequests.projectId, projectId),
          isNull(changeRequests.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Change request not found");
    await this.db
      .update(changeRequests)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(changeRequests.id, crId),
          eq(changeRequests.orgId, orgId),
          eq(changeRequests.projectId, projectId),
          isNull(changeRequests.deletedAt),
        ),
      );
    this.audit.log({
      action: "change_request.deleted",
      userId,
      orgId,
      resourceType: "change_request",
      resourceId: String(crId),
      metadata: { crId, projectId },
    });
  }
}
