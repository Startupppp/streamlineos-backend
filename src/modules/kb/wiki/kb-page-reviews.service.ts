import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  kbPageReviews,
  kbPages,
  organizationMembers,
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

type ReviewRow = typeof kbPageReviews.$inferSelect;

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
