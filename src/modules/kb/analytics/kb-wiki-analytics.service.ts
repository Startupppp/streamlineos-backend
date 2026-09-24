import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  kbPageVersions,
  kbPageVisits,
  kbPages,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import {
  encodeCursor,
  decodeTimestampCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  keysetAfterId,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import type {
  WikiAnalyticsQuery,
  WikiPageStatItem,
  WikiStalePageItem,
  WikiContributorItem,
} from "./dto/kb-wiki-analytics.schemas";

const STALE_THRESHOLD_DAYS = 90;
const CONTRIBUTOR_LIMIT = 50;

@Injectable()
export class KbWikiAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async pageStats(
    user: CurrentUserContext,
    query: WikiAnalyticsQuery,
  ): Promise<CursorPage<WikiPageStatItem>> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(user, "view");

    const conditions: (SQL<unknown> | undefined)[] = [
      eq(kbPages.orgId, user.orgId),
      isNull(kbPages.deletedAt),
      visibilityPredicate,
    ];

    if (query.from !== undefined) {
      conditions.push(gte(kbPages.updatedAt, new Date(query.from)));
    }
    if (query.to !== undefined) {
      conditions.push(lte(kbPages.updatedAt, new Date(query.to)));
    }
    if (query.spaceId !== undefined) {
      conditions.push(eq(kbPages.spaceId, query.spaceId));
    }

    const position = decodeTimestampCursor(query.cursor);
    if (position !== null) {
      conditions.push(keysetBeforeMicros(kbPages.updatedAt, kbPages.id, position));
    }

    const rows = await this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        spaceId: kbPages.spaceId,
        status: kbPages.status,
        trustState: kbPages.trustState,
        updatedAt: kbPages.updatedAt,
        updatedAtMicros: microsecondCursorValue(kbPages.updatedAt),
        uniqueViewers: sql<number>`count(distinct ${kbPageVisits.id})::int`,
      })
      .from(kbPages)
      .leftJoin(
        kbPageVisits,
        and(
          eq(kbPageVisits.orgId, kbPages.orgId),
          eq(kbPageVisits.pageId, kbPages.id),
        ),
      )
      .where(and(...conditions))
      .groupBy(kbPages.id)
      .orderBy(desc(kbPages.updatedAt), desc(kbPages.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept[kept.length - 1];

    return {
      data: kept.map(({ updatedAtMicros: _micros, ...item }) => item),
      pagination: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor({ sortValue: last.updatedAtMicros, id: String(last.id) })
            : null,
      },
    };
  }

  async stalePages(
    user: CurrentUserContext,
    query: WikiAnalyticsQuery,
  ): Promise<CursorPage<WikiStalePageItem>> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(user, "view");
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - STALE_THRESHOLD_DAYS);

    const conditions: (SQL<unknown> | undefined)[] = [
      eq(kbPages.orgId, user.orgId),
      isNull(kbPages.deletedAt),
      visibilityPredicate,
      lte(kbPages.updatedAt, threshold),
    ];

    if (query.spaceId !== undefined) {
      conditions.push(eq(kbPages.spaceId, query.spaceId));
    }

    const position = decodeTimestampCursor(query.cursor);
    if (position !== null) {
      conditions.push(keysetAfterId(kbPages.updatedAt, kbPages.id, position));
    }

    const rows = await this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        spaceId: kbPages.spaceId,
        status: kbPages.status,
        ownerMembershipId: kbPages.ownerMembershipId,
        updatedAt: kbPages.updatedAt,
        updatedAtMicros: microsecondCursorValue(kbPages.updatedAt),
        uniqueViewers: sql<number>`count(distinct ${kbPageVisits.id})::int`,
      })
      .from(kbPages)
      .leftJoin(
        kbPageVisits,
        and(
          eq(kbPageVisits.orgId, kbPages.orgId),
          eq(kbPageVisits.pageId, kbPages.id),
        ),
      )
      .where(and(...conditions))
      .groupBy(kbPages.id)
      .orderBy(asc(kbPages.updatedAt), asc(kbPages.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept[kept.length - 1];

    return {
      data: kept.map(({ updatedAtMicros: _micros, ...item }) => item),
      pagination: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor({ sortValue: last.updatedAtMicros, id: String(last.id) })
            : null,
      },
    };
  }

  async contributorActivity(
    user: CurrentUserContext,
    query: WikiAnalyticsQuery,
  ): Promise<WikiContributorItem[]> {
    const visibilityPredicate = await this.auth.visiblePagePredicate(user, "view");

    const conditions: (SQL<unknown> | undefined)[] = [
      eq(kbPageVersions.orgId, user.orgId),
    ];

    if (query.from !== undefined) {
      conditions.push(gte(kbPageVersions.createdAt, new Date(query.from)));
    }
    if (query.to !== undefined) {
      conditions.push(lte(kbPageVersions.createdAt, new Date(query.to)));
    }

    return this.db
      .select({
        membershipId: kbPageVersions.authorMembershipId,
        editCount: sql<number>`count(*)::int`,
      })
      .from(kbPageVersions)
      .innerJoin(
        kbPages,
        and(
          eq(kbPageVersions.pageId, kbPages.id),
          eq(kbPageVersions.orgId, kbPages.orgId),
          isNull(kbPages.deletedAt),
          visibilityPredicate,
        ),
      )
      .where(and(...conditions))
      .groupBy(kbPageVersions.authorMembershipId)
      .orderBy(desc(sql`count(*)`))
      .limit(CONTRIBUTOR_LIMIT);
  }
}
