import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
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
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import type { KeysetPosition } from "../../../common/pagination/keyset";
import { keysetAfterId } from "../../../common/pagination/keyset";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";
import { pageVisibleTo } from "../retrieval/kb-page-visibility";
import { reviewerCanSeeAllReviews } from "./kb-page-reviews.service";

type ReviewRow = typeof kbPageReviews.$inferSelect;
const REVIEW_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
const REVIEW_TYPES = ["approval", "freshness"] as const;

function isReviewStatus(value: string): value is ReviewRow["status"] {
  return REVIEW_STATUSES.some((status) => status === value);
}

function isReviewType(value: string): value is ReviewRow["type"] {
  return REVIEW_TYPES.some((type) => type === value);
}

type ReviewWithContext = ReviewRow & {
  pageTitle: string | null;
  requestedByName: string | null;
  reviewerName: string | null;
};

@Injectable()
export class KbPageReviewsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private actorMembershipId(user: CurrentUserContext): number {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId === null)
      throw new ForbiddenException("An organization membership is required");
    return membershipId;
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
    if (status && isReviewStatus(status)) {
      conditions.push(eq(kbPageReviews.status, status));
    }
    if (type && isReviewType(type)) {
      conditions.push(eq(kbPageReviews.type, type));
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
}
