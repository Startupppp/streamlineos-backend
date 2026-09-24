import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveWindowedTotal, totalOverWindow } from "../../../common/pagination/window-count";
import { supportArticlePredicate } from "./kb-article-page-scope";

type VerificationQueueItem = {
  id: number;
  spaceId: number | null;
  categoryId: number | null;
  title: string;
  slug: string;
  ownerMembershipId: number | null;
  reviewIntervalDays: number | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
};

type VerificationQueueResult = {
  items: VerificationQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

@Injectable()
export class KbVerificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
  ) {}

  async listDue(user: CurrentUserContext, page: number, pageSize: number): Promise<VerificationQueueResult> {
    const capped = Math.min(pageSize, 100);
    const spaceIds = await this.access.getAccessibleSpaceIds(user);
    if (spaceIds.length === 0) {
      return { items: [], total: 0, page, pageSize: capped, totalPages: 0 };
    }

    const scheduledReviewReached = lte(kbPages.nextReviewAt, sql`now()`);
    const trustLapsed = or(
      eq(kbPages.trustState, "verification_expired"),
      lt(kbPages.verifiedUntil, sql`now()`),
    );
    const neverVerifiedOnACadence = and(
      eq(kbPages.trustState, "unverified"),
      isNotNull(kbPages.reviewIntervalDays),
    );

    const where = and(
      eq(kbPages.orgId, user.orgId),
      supportArticlePredicate(),
      eq(kbPages.status, "published"),
      or(scheduledReviewReached, trustLapsed, neverVerifiedOnACadence),
    );

    const offset = (page - 1) * capped;
    const rows = await this.db
      .select({
        total: totalOverWindow,
        id: kbPages.id,
        spaceId: kbPages.spaceId,
        categoryId: kbPages.categoryId,
        title: kbPages.title,
        slug: sql<string>`coalesce(${kbPages.slug}, '')`,
        ownerMembershipId: kbPages.ownerMembershipId,
        reviewIntervalDays: kbPages.reviewIntervalDays,
        verifiedAt: kbPages.verifiedAt,
        updatedAt: kbPages.updatedAt,
      })
      .from(kbPages)
      .where(where)
      .orderBy(asc(kbPages.nextReviewAt), asc(kbPages.id))
      .limit(capped)
      .offset(offset);

    const total = await resolveWindowedTotal(rows, offset, async () => {
      const [countRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPages)
        .where(where);
      return Number(countRow?.count ?? 0);
    });
    const items = rows.map((row) => ({
      id: row.id,
      spaceId: row.spaceId,
      categoryId: row.categoryId,
      title: row.title,
      slug: row.slug,
      ownerMembershipId: row.ownerMembershipId,
      reviewIntervalDays: row.reviewIntervalDays,
      lastVerifiedAt: row.verifiedAt,
      updatedAt: row.updatedAt,
    }));

    return { items, total, page, pageSize: capped, totalPages: Math.ceil(total / capped) };
  }
}
