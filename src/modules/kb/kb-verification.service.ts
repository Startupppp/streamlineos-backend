import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNotNull, lt, or, isNull, sql } from "drizzle-orm";
import { kbArticles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { KbAccessService } from "./kb-access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

type VerificationQueueItem = {
  id: number;
  spaceId: number | null;
  categoryId: number | null;
  title: string;
  slug: string;
  ownerId: string | null;
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

    const overdue = and(
      isNotNull(kbArticles.reviewIntervalDays),
      lt(
        sql`${kbArticles.lastVerifiedAt} + (${kbArticles.reviewIntervalDays} || ' days')::interval`,
        sql`now()`,
      ),
    );

    const neverVerified = and(
      isNotNull(kbArticles.reviewIntervalDays),
      isNull(kbArticles.lastVerifiedAt),
    );

    const where = and(
      eq(kbArticles.orgId, user.orgId),
      eq(kbArticles.status, "published"),
      or(overdue, neverVerified),
    );

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbArticles)
      .where(where);
    const total = countRow?.count ?? 0;

    const items = await this.db
      .select({
        id: kbArticles.id,
        spaceId: kbArticles.spaceId,
        categoryId: kbArticles.categoryId,
        title: kbArticles.title,
        slug: kbArticles.slug,
        ownerId: kbArticles.ownerId,
        reviewIntervalDays: kbArticles.reviewIntervalDays,
        lastVerifiedAt: kbArticles.lastVerifiedAt,
        updatedAt: kbArticles.updatedAt,
      })
      .from(kbArticles)
      .where(where)
      .orderBy(asc(kbArticles.lastVerifiedAt))
      .limit(capped)
      .offset((page - 1) * capped);

    return { items, total, page, pageSize: capped, totalPages: Math.ceil(total / capped) };
  }
}
