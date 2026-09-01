import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
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
} from "./dto/kb-page-reviews.schemas";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import type { KeysetPosition } from "../../../common/pagination/keyset";
import { keysetAfterId } from "../../../common/pagination/keyset";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";
import { pageVisibleTo } from "../retrieval/kb-page-visibility";

type ReviewRow = typeof kbPageReviews.$inferSelect;
const REVIEW_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
const REVIEW_TYPES = ["approval", "freshness"] as const;

type ReviewWithContext = ReviewRow & {
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

@Injectable()
export class KbPageReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly access: AccessService,
  ) {}

  private actorMembershipId(user: CurrentUserContext): number {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId === null)
      throw new ForbiddenException("An organization membership is required");
    return membershipId;
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

  async list(
    user: CurrentUserContext,
    status: string | undefined,
    type: string | undefined,
  ): Promise<ReviewWithContext[]> {
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

    const conditions = [eq(kbPageReviews.orgId, user.orgId)];
    if (status && REVIEW_STATUSES.includes(status as ReviewRow["status"])) {
      conditions.push(eq(kbPageReviews.status, status as ReviewRow["status"]));
    }
    if (type && REVIEW_TYPES.includes(type as ReviewRow["type"])) {
      conditions.push(eq(kbPageReviews.type, type as ReviewRow["type"]));
    }
    if (!(await reviewerCanSeeAllReviews(user, this.access))) {
      const membershipId = this.actorMembershipId(user);
      const ownOnly = or(
        eq(kbPageReviews.reviewerMembershipId, membershipId),
        eq(kbPageReviews.requestedByMembershipId, membershipId),
      );
      if (ownOnly) conditions.push(ownOnly);
    }

    return this.db
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
      .where(and(...conditions))
      .orderBy(sql`${kbPageReviews.dueAt} ASC NULLS LAST`)
      .limit(100);
  }

  async listDue(user: CurrentUserContext, cursor?: KeysetPosition): Promise<ReviewWithContext[]> {
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

    const projectIds = await getAccessibleProjectIds(this.db, user);
    const canSeeAll = await reviewerCanSeeAllReviews(user, this.access);

    const conditions = [
      eq(kbPageReviews.orgId, user.orgId),
      eq(kbPageReviews.status, "pending"),
      eq(kbPageReviews.type, "freshness"),
      isNotNull(kbPageReviews.dueAt),
      lte(kbPageReviews.dueAt, new Date()),
      pageVisibleTo(user, projectIds),
    ];

    if (!canSeeAll) {
      const membershipId = this.actorMembershipId(user);
      const ownOnly = or(
        eq(kbPageReviews.reviewerMembershipId, membershipId),
        eq(kbPageReviews.requestedByMembershipId, membershipId),
      );
      if (ownOnly) conditions.push(ownOnly);
    }

    if (cursor) conditions.push(keysetAfterId(kbPageReviews.dueAt, kbPageReviews.id, cursor));

    return this.db
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
      .innerJoin(kbPages, and(eq(kbPageReviews.pageId, kbPages.id), isNull(kbPages.deletedAt)))
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
      .where(and(...conditions))
      .orderBy(asc(kbPageReviews.dueAt), asc(kbPageReviews.id))
      .limit(50);
  }

  async create(
    user: CurrentUserContext,
    pageId: number,
    input: CreatePageReviewInput,
  ): Promise<ReviewRow> {
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

    return review;
  }

  async approve(
    user: CurrentUserContext,
    reviewId: number,
    input: ApproveReviewInput,
  ): Promise<ReviewRow> {
    const existing = await this.db.query.kbPageReviews.findFirst({
      where: and(
        eq(kbPageReviews.id, reviewId),
        eq(kbPageReviews.orgId, user.orgId),
      ),
    });
    if (!existing) throw new NotFoundException("Review not found");
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

    return updated;
  }

  async reject(
    user: CurrentUserContext,
    reviewId: number,
    input: RejectReviewInput,
  ): Promise<ReviewRow> {
    const existing = await this.db.query.kbPageReviews.findFirst({
      where: and(
        eq(kbPageReviews.id, reviewId),
        eq(kbPageReviews.orgId, user.orgId),
      ),
    });
    if (!existing) throw new NotFoundException("Review not found");
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

    return updated;
  }
}
