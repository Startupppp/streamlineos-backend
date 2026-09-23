import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or, type SQL } from "drizzle-orm";
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
import { keysetAfterId } from "../../../common/pagination/keyset";
import {
  buildCursorPage,
  decodeCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import { reviewerCanSeeAllReviews } from "./kb-page-reviews.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import type { ListPageReviewsQuery } from "./dto/kb-page-reviews.schemas";

type ReviewRow = typeof kbPageReviews.$inferSelect;

export interface ReviewListItem {
  id: number;
  orgId: string;
  pageId: number;
  type: ReviewRow["type"];
  status: ReviewRow["status"];
  isOverdue: boolean;
  requestedById: string | null;
  reviewerId: string | null;
  requestedByMembershipId: number | null;
  reviewerMembershipId: number | null;
  dueAt: Date | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  pageTitle: string | null;
  requestedByName: string | null;
  reviewerName: string | null;
}

const NULL_DUE_SENTINEL = "9999-12-31T00:00:00.000Z";

const REVIEW_LIST_COLUMNS = {
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
};

@Injectable()
export class KbPageReviewsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async list(
    user: CurrentUserContext,
    query: ListPageReviewsQuery,
  ): Promise<CursorPage<ReviewListItem>> {
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

    const visibilityPredicate = await this.auth.visiblePagePredicate(user, "view");
    const canSeeAll = await reviewerCanSeeAllReviews(user, this.access);
    const now = new Date();

    const conditions: (SQL<unknown> | undefined)[] = [
      eq(kbPageReviews.orgId, user.orgId),
    ];

    if (query.status === "overdue") {
      conditions.push(eq(kbPageReviews.status, "pending"));
      conditions.push(lt(kbPageReviews.dueAt, now));
    } else if (query.status !== undefined) {
      conditions.push(eq(kbPageReviews.status, query.status));
    }

    if (query.type !== undefined) {
      conditions.push(eq(kbPageReviews.type, query.type));
    }

    if (query.reviewer !== undefined) {
      conditions.push(eq(kbPageReviews.reviewerId, query.reviewer));
    }

    if (query.dueFrom !== undefined) {
      conditions.push(gte(kbPageReviews.dueAt, new Date(query.dueFrom)));
    }

    if (query.dueTo !== undefined) {
      conditions.push(lte(kbPageReviews.dueAt, new Date(query.dueTo)));
    }

    if (!canSeeAll) {
      const membershipId = actingMembershipId(user.principal);
      if (membershipId === null) {
        throw new ForbiddenException("An organization membership is required");
      }
      const ownOnly = or(
        eq(kbPageReviews.reviewerMembershipId, membershipId),
        eq(kbPageReviews.requestedByMembershipId, membershipId),
      );
      conditions.push(ownOnly);
    }

    const position = decodeCursor(query.cursor);
    if (position) {
      if (position.sortValue === NULL_DUE_SENTINEL) {
        conditions.push(
          and(
            isNull(kbPageReviews.dueAt),
            gt(kbPageReviews.id, Number(position.id)),
          ),
        );
      } else {
        conditions.push(
          or(
            keysetAfterId(kbPageReviews.dueAt, kbPageReviews.id, {
              sortValue: position.sortValue,
              id: position.id,
            }),
            isNull(kbPageReviews.dueAt),
          ),
        );
      }
    }

    const orderFn = query.sortDir === "desc" ? desc : asc;

    const rows = await this.db
      .select({
        ...REVIEW_LIST_COLUMNS,
        pageTitle: kbPages.title,
        requestedByName: requester.name,
        reviewerName: reviewer.name,
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
      .orderBy(
        orderFn(kbPageReviews.dueAt),
        orderFn(kbPageReviews.id),
      )
      .limit(query.limit + 1);

    const withDerived = rows.map((row) => ({
      ...row,
      isOverdue: row.status === "pending" && row.dueAt !== null && row.dueAt < now,
    }));

    return buildCursorPage(withDerived, query.limit, (row) => ({
      sortValue: row.dueAt ? row.dueAt.toISOString() : NULL_DUE_SENTINEL,
      id: String(row.id),
    }));
  }
}
