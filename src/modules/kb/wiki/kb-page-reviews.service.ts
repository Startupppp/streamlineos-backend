import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  kbPageReviews,
  kbPages,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreatePageReviewInput,
  ApproveReviewInput,
  RejectReviewInput,
  BulkDecidePageReviewsInput,
} from "./dto/kb-page-reviews.schemas";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";

type ReviewRow = typeof kbPageReviews.$inferSelect;

type ReviewWithContext = ReviewRow & {
  isOverdue: boolean;
  pageTitle: string | null;
  requestedByName: string | null;
  reviewerName: string | null;
};

export async function reviewerCanSeeAllReviews(
  user: CurrentUserContext,
  access: Pick<AccessService, "holds">,
): Promise<boolean> {
  return access.holds(user, "kb:reviews:manage");
}

export interface BulkDecideResultItem {
  id: number;
  outcome: "succeeded" | "denied" | "conflict" | "notFound";
}

@Injectable()
export class KbPageReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly access: AccessService,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  private actorMembershipId(user: CurrentUserContext): number {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId === null)
      throw new ForbiddenException("An organization membership is required");
    return membershipId;
  }

  private async assertReviewPageVisible(
    user: CurrentUserContext,
    pageId: number,
  ): Promise<void> {
    await this.auth
      .assertPageAccess(user, pageId, "view")
      .catch(() => {
        throw new NotFoundException("Review not found");
      });
  }

  private async reviewerMembershipId(
    orgId: string,
    reviewerId: string | undefined,
  ): Promise<number | null> {
    if (!reviewerId) return null;
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, reviewerId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!membership)
      throw new NotFoundException("Reviewer not found in this organization");
    return membership.id;
  }

  async create(
    user: CurrentUserContext,
    pageId: number,
    input: CreatePageReviewInput,
  ): Promise<ReviewWithContext> {
    await this.auth.assertPageAccess(user, pageId, "view");
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
      ),
      columns: { id: true, title: true },
    });
    if (!page) throw new NotFoundException("Page not found");
    const requestedByMembershipId = this.actorMembershipId(user);
    const reviewerMembershipId = await this.reviewerMembershipId(
      user.orgId,
      input.reviewerId,
    );

    const [review] = await this.db
      .insert(kbPageReviews)
      .values({
        orgId: user.orgId,
        pageId,
        type: input.type,
        requestedById: user.userId,
        reviewerId: input.reviewerId ?? null,
        requestedByMembershipId,
        reviewerMembershipId,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        decisionNote: input.note ?? null,
      })
      .returning();
    if (!review)
      throw new InternalServerErrorException("Failed to create review");

    this.audit.log({
      action: "kb.review.created",
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_page_review",
      resourceId: String(review.id),
      metadata: { pageId, type: input.type },
    });

    if (review.reviewerId && review.reviewerId !== user.userId) {
      await this.dispatch.emit({
        eventKey: "knowledge.page.review_requested",
        orgId: user.orgId,
        actorUserId: user.userId,
        targetUserIds: [review.reviewerId],
        entityType: "kb_page",
        entityId: String(pageId),
        title: `Review requested: ${page.title}`,
        message: `You have been assigned a ${input.type} review for "${page.title}".`,
      });
    }

    return this.loadWithContext(user.orgId, review.id);
  }

  async approve(
    user: CurrentUserContext,
    reviewId: number,
    input: ApproveReviewInput,
  ): Promise<ReviewWithContext> {
    const existing = await this.db.query.kbPageReviews.findFirst({
      where: and(
        eq(kbPageReviews.id, reviewId),
        eq(kbPageReviews.orgId, user.orgId),
      ),
    });
    if (!existing) throw new NotFoundException("Review not found");
    await this.assertReviewPageVisible(user, existing.pageId);
    const reviewerMembershipId = this.actorMembershipId(user);

    const [updated] = await this.db
      .update(kbPageReviews)
      .set({
        status: "approved",
        reviewerId: user.userId,
        reviewerMembershipId,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      })
      .where(
        and(
          eq(kbPageReviews.id, reviewId),
          eq(kbPageReviews.orgId, user.orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Review not found");

    this.audit.log({
      action: "kb.review.approved",
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_page_review",
      resourceId: String(reviewId),
      before: { status: existing.status },
      after: { status: "approved" },
    });

    if (existing.requestedById) {
      await this.dispatch.emit({
        eventKey: "knowledge.page.review_approved",
        orgId: user.orgId,
        actorUserId: user.userId,
        targetUserIds: [existing.requestedById],
        entityType: "kb_page_review",
        entityId: String(reviewId),
        title: "Page review approved",
        message: `Your review request (ID ${reviewId}) was approved.`,
      });
    }

    return this.loadWithContext(user.orgId, reviewId);
  }

  async reject(
    user: CurrentUserContext,
    reviewId: number,
    input: RejectReviewInput,
  ): Promise<ReviewWithContext> {
    const existing = await this.db.query.kbPageReviews.findFirst({
      where: and(
        eq(kbPageReviews.id, reviewId),
        eq(kbPageReviews.orgId, user.orgId),
      ),
    });
    if (!existing) throw new NotFoundException("Review not found");
    await this.assertReviewPageVisible(user, existing.pageId);
    const reviewerMembershipId = this.actorMembershipId(user);

    const [updated] = await this.db
      .update(kbPageReviews)
      .set({
        status: "rejected",
        reviewerId: user.userId,
        reviewerMembershipId,
        decidedAt: new Date(),
        decisionNote: input.note,
      })
      .where(
        and(
          eq(kbPageReviews.id, reviewId),
          eq(kbPageReviews.orgId, user.orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Review not found");

    this.audit.log({
      action: "kb.review.rejected",
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_page_review",
      resourceId: String(reviewId),
      before: { status: existing.status },
      after: { status: "rejected" },
      metadata: { note: input.note },
    });

    if (existing.requestedById) {
      await this.dispatch.emit({
        eventKey: "knowledge.page.review_rejected",
        orgId: user.orgId,
        actorUserId: user.userId,
        targetUserIds: [existing.requestedById],
        entityType: "kb_page_review",
        entityId: String(reviewId),
        title: "Page review rejected",
        message: `Your review request (ID ${reviewId}) was rejected. Note: ${input.note}`,
      });
    }

    return this.loadWithContext(user.orgId, reviewId);
  }

  async bulkDecide(
    user: CurrentUserContext,
    input: BulkDecidePageReviewsInput,
  ): Promise<{ results: BulkDecideResultItem[] }> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(
      user,
      "view",
    );

    const visibleReviews = await this.db
      .select({
        id: kbPageReviews.id,
        status: kbPageReviews.status,
      })
      .from(kbPageReviews)
      .innerJoin(
        kbPages,
        and(
          eq(kbPageReviews.pageId, kbPages.id),
          eq(kbPageReviews.orgId, kbPages.orgId),
          isNull(kbPages.deletedAt),
          visibilityPredicate,
        ),
      )
      .where(
        and(
          eq(kbPageReviews.orgId, user.orgId),
          inArray(kbPageReviews.id, input.ids),
        ),
      );

    const visibleMap = new Map(visibleReviews.map((r) => [r.id, r.status]));
    const membershipId = actingMembershipId(user.principal);

    const pendingIds = input.ids.filter(
      (id) => visibleMap.get(id) === "pending",
    );

    let succeededSet = new Set<number>();
    if (pendingIds.length > 0 && membershipId !== null) {
      const updated = await this.db
        .update(kbPageReviews)
        .set({
          status: input.decision,
          reviewerId: user.userId,
          reviewerMembershipId: membershipId,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
        })
        .where(
          and(
            eq(kbPageReviews.orgId, user.orgId),
            inArray(kbPageReviews.id, pendingIds),
            eq(kbPageReviews.status, "pending"),
          ),
        )
        .returning({ id: kbPageReviews.id });
      succeededSet = new Set(updated.map((r) => r.id));
    }

    const results: BulkDecideResultItem[] = input.ids.map((id) => {
      const status = visibleMap.get(id);
      if (status === undefined) return { id, outcome: "notFound" };
      if (status !== "pending") return { id, outcome: "conflict" };
      if (membershipId === null) return { id, outcome: "denied" };
      return { id, outcome: succeededSet.has(id) ? "succeeded" : "conflict" };
    });

    return { results };
  }

  private async loadWithContext(
    orgId: string,
    reviewId: number,
  ): Promise<ReviewWithContext> {
    const requester = alias(users, "requester");
    const reviewer = alias(users, "reviewer");
    const requesterMembership = alias(
      organizationMembers,
      "reviewer_requester_membership",
    );
    const reviewerMembership = alias(
      organizationMembers,
      "reviewer_assignee_membership",
    );
    const [row] = await this.db
      .select({
        id: kbPageReviews.id,
        orgId: kbPageReviews.orgId,
        pageId: kbPageReviews.pageId,
        type: kbPageReviews.type,
        status: kbPageReviews.status,
        requestedById: kbPageReviews.requestedById,
        reviewerId: kbPageReviews.reviewerId,
        requestedByMembershipId: kbPageReviews.requestedByMembershipId,
        reviewerMembershipId: kbPageReviews.reviewerMembershipId,
        dueAt: kbPageReviews.dueAt,
        decidedAt: kbPageReviews.decidedAt,
        decisionNote: kbPageReviews.decisionNote,
        createdAt: kbPageReviews.createdAt,
        updatedAt: kbPageReviews.updatedAt,
        pageTitle: kbPages.title,
        requestedByName: requester.name,
        reviewerName: reviewer.name,
      })
      .from(kbPageReviews)
      .leftJoin(kbPages, eq(kbPageReviews.pageId, kbPages.id))
      .leftJoin(
        requesterMembership,
        eq(kbPageReviews.requestedByMembershipId, requesterMembership.id),
      )
      .leftJoin(
        reviewerMembership,
        eq(kbPageReviews.reviewerMembershipId, reviewerMembership.id),
      )
      .leftJoin(requester, eq(requesterMembership.userId, requester.id))
      .leftJoin(reviewer, eq(reviewerMembership.userId, reviewer.id))
      .where(
        and(eq(kbPageReviews.id, reviewId), eq(kbPageReviews.orgId, orgId)),
      );
    if (!row)
      throw new InternalServerErrorException("Review not found after save");
    return {
      ...row,
      isOverdue: row.status === "pending" && row.dueAt !== null && row.dueAt < new Date(),
    };
  }
}
