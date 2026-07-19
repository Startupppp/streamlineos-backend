import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { kbPageReviews, kbPages, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  CreatePageReviewInput,
  ApproveReviewInput,
  RejectReviewInput,
} from "./dto/kb-page-reviews.schemas";

type ReviewRow = typeof kbPageReviews.$inferSelect;
const REVIEW_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
const REVIEW_TYPES = ["approval", "freshness"] as const;

type ReviewWithContext = ReviewRow & {
  pageTitle: string | null;
  requestedByName: string | null;
  reviewerName: string | null;
};

@Injectable()
export class KbPageReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async list(
    orgId: string,
    status: string | undefined,
    type: string | undefined,
  ): Promise<ReviewWithContext[]> {
    const requester = alias(users, "requester");
    const reviewer = alias(users, "reviewer");

    const conditions = [eq(kbPageReviews.orgId, orgId)];
    if (status && REVIEW_STATUSES.includes(status as ReviewRow["status"])) {
      conditions.push(eq(kbPageReviews.status, status as ReviewRow["status"]));
    }
    if (type && REVIEW_TYPES.includes(type as ReviewRow["type"])) {
      conditions.push(eq(kbPageReviews.type, type as ReviewRow["type"]));
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
      .leftJoin(requester, eq(kbPageReviews.requestedById, requester.id))
      .leftJoin(reviewer, eq(kbPageReviews.reviewerId, reviewer.id))
      .where(and(...conditions))
      .orderBy(sql`${kbPageReviews.dueAt} ASC NULLS LAST`)
      .limit(100);
  }

  async listDue(orgId: string): Promise<ReviewWithContext[]> {
    const requester = alias(users, "requester");
    const reviewer = alias(users, "reviewer");

    return this.db
      .select({
        id: kbPageReviews.id,
        orgId: kbPageReviews.orgId,
        pageId: kbPageReviews.pageId,
        type: kbPageReviews.type,
        status: kbPageReviews.status,
        requestedById: kbPageReviews.requestedById,
        reviewerId: kbPageReviews.reviewerId,
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
      .leftJoin(requester, eq(kbPageReviews.requestedById, requester.id))
      .leftJoin(reviewer, eq(kbPageReviews.reviewerId, reviewer.id))
      .where(
        and(
          eq(kbPageReviews.orgId, orgId),
          eq(kbPageReviews.status, "pending"),
          eq(kbPageReviews.type, "freshness"),
          isNotNull(kbPageReviews.dueAt),
          lte(kbPageReviews.dueAt, new Date()),
        ),
      )
      .orderBy(asc(kbPageReviews.dueAt))
      .limit(100);
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

    const [review] = await this.db
      .insert(kbPageReviews)
      .values({
        orgId: user.orgId,
        pageId,
        type: input.type,
        requestedById: user.userId,
        reviewerId: input.reviewerId ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        decisionNote: input.note ?? null,
      })
      .returning();
    if (!review) throw new Error("Failed to create review");

    this.audit.log({
      action: "kb.review.created",
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_page_review",
      resourceId: String(review.id),
      metadata: { pageId, type: input.type },
    });

    if (review.reviewerId && review.reviewerId !== user.userId) {
      void this.dispatch
        .emit({
          eventKey: "knowledge.page.review_requested",
          orgId: user.orgId,
          actorUserId: user.userId,
          targetUserIds: [review.reviewerId],
          entityType: "kb_page",
          entityId: String(pageId),
          title: `Review requested: ${page.title}`,
          message: `You have been assigned a ${input.type} review for "${page.title}".`,
        })
        .catch(function notifError(err: unknown) {
          console.error("Failed to send review request notification", err);
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
      where: and(eq(kbPageReviews.id, reviewId), eq(kbPageReviews.orgId, user.orgId)),
    });
    if (!existing) throw new NotFoundException("Review not found");

    const [updated] = await this.db
      .update(kbPageReviews)
      .set({
        status: "approved",
        reviewerId: user.userId,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      })
      .where(and(eq(kbPageReviews.id, reviewId), eq(kbPageReviews.orgId, user.orgId)))
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
      void this.dispatch
        .emit({
          eventKey: "knowledge.page.review_approved",
          orgId: user.orgId,
          actorUserId: user.userId,
          targetUserIds: [existing.requestedById],
          entityType: "kb_page_review",
          entityId: String(reviewId),
          title: "Page review approved",
          message: `Your review request (ID ${reviewId}) was approved.`,
        })
        .catch(function notifError(err: unknown) {
          console.error("Failed to send review approval notification", err);
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
      where: and(eq(kbPageReviews.id, reviewId), eq(kbPageReviews.orgId, user.orgId)),
    });
    if (!existing) throw new NotFoundException("Review not found");

    const [updated] = await this.db
      .update(kbPageReviews)
      .set({
        status: "rejected",
        reviewerId: user.userId,
        decidedAt: new Date(),
        decisionNote: input.note,
      })
      .where(and(eq(kbPageReviews.id, reviewId), eq(kbPageReviews.orgId, user.orgId)))
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
      void this.dispatch
        .emit({
          eventKey: "knowledge.page.review_rejected",
          orgId: user.orgId,
          actorUserId: user.userId,
          targetUserIds: [existing.requestedById],
          entityType: "kb_page_review",
          entityId: String(reviewId),
          title: "Page review rejected",
          message: `Your review request (ID ${reviewId}) was rejected. Note: ${input.note}`,
        })
        .catch(function notifError(err: unknown) {
          console.error("Failed to send review rejection notification", err);
        });
    }

    return updated;
  }
}
