import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { KbAccessService } from "./kb-access.service";
import type { RangeInput } from "./dto/kb-analytics.schemas";

@Injectable()
export class KbAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
  ) {}

  async overview(orgId: string, range: RangeInput) {
    const eventConditions: SQL[] = [eq(kbEvents.orgId, orgId)];
    if (range.from) eventConditions.push(gte(kbEvents.occurredAt, new Date(range.from)));
    if (range.to) eventConditions.push(lte(kbEvents.occurredAt, new Date(range.to)));

    const [articleStats] = await this.db
      .select({
        totalCount: sql<number>`count(*)::int`,
        publishedCount: sql<number>`(count(*) filter (where ${kbArticles.status} = 'published'))::int`,
        archivedCount: sql<number>`(count(*) filter (where ${kbArticles.status} = 'archived'))::int`,
        totalViews: sql<number>`coalesce(sum(${kbArticles.views}), 0)::int`,
        helpfulUp: sql<number>`coalesce(sum(${kbArticles.helpfulCount}), 0)::int`,
        helpfulDown: sql<number>`coalesce(sum(${kbArticles.notHelpfulCount}), 0)::int`,
        verifiedPublished: sql<number>`(count(*) filter (where ${kbArticles.status} = 'published' and ${kbArticles.lastVerifiedAt} is not null and (${kbArticles.reviewIntervalDays} is null or ${kbArticles.lastVerifiedAt} + (${kbArticles.reviewIntervalDays} || ' days')::interval >= now())))::int`,
      })
      .from(kbArticles)
      .where(eq(kbArticles.orgId, orgId));

    const [eventStats] = await this.db
      .select({
        searches: sql<number>`(count(*) filter (where ${kbEvents.eventType} in ('search', 'search_no_results')))::int`,
        noResults: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'search_no_results'))::int`,
        aiAnswers: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'ai_answer'))::int`,
        views: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'view'))::int`,
      })
      .from(kbEvents)
      .where(and(...eventConditions));

    const topArticles = await this.db
      .select({
        id: kbArticles.id,
        title: kbArticles.title,
        slug: kbArticles.slug,
        spaceId: kbArticles.spaceId,
        viewCount: kbArticles.views,
        helpfulCount: kbArticles.helpfulCount,
        notHelpfulCount: kbArticles.notHelpfulCount,
      })
      .from(kbArticles)
      .where(and(eq(kbArticles.orgId, orgId), eq(kbArticles.status, "published")))
      .orderBy(desc(kbArticles.views))
      .limit(10);

    const totalCount = articleStats?.totalCount ?? 0;
    const publishedCount = articleStats?.publishedCount ?? 0;
    const archivedCount = articleStats?.archivedCount ?? 0;
    const totalViews = articleStats?.totalViews ?? 0;
    const helpfulUp = articleStats?.helpfulUp ?? 0;
    const helpfulDown = articleStats?.helpfulDown ?? 0;
    const verifiedPublished = articleStats?.verifiedPublished ?? 0;

    const searches = eventStats?.searches ?? 0;
    const noResults = eventStats?.noResults ?? 0;
    const aiAnswers = eventStats?.aiAnswers ?? 0;
    const views = eventStats?.views ?? 0;

    const helpfulRatio = helpfulUp + helpfulDown > 0 ? helpfulUp / (helpfulUp + helpfulDown) : 0;
    const searchSuccessRate = searches > 0 ? (searches - noResults) / searches : 0;
    const trustScore = publishedCount > 0 ? verifiedPublished / publishedCount : 0;

    return {
      totalCount,
      publishedCount,
      archivedCount,
      totalViews,
      helpfulUp,
      helpfulDown,
      helpfulRatio,
      searches,
      noResults,
      searchSuccessRate,
      aiAnswers,
      views,
      verifiedPublished,
      trustScore,
      topArticles,
    };
  }

  async noResults(orgId: string, range: RangeInput) {
    const conditions: SQL[] = [
      eq(kbEvents.orgId, orgId),
      eq(kbEvents.eventType, "search_no_results"),
    ];
    if (range.from) conditions.push(gte(kbEvents.occurredAt, new Date(range.from)));
    if (range.to) conditions.push(lte(kbEvents.occurredAt, new Date(range.to)));

    return this.db
      .select({
        query: kbEvents.query,
        count: sql<number>`count(*)::int`,
      })
      .from(kbEvents)
      .where(and(...conditions))
      .groupBy(kbEvents.query)
      .orderBy(desc(sql`count(*)`))
      .limit(20);
  }

  async verificationQueue(orgId: string) {
    return this.db
      .select({
        id: kbArticles.id,
        title: kbArticles.title,
        slug: kbArticles.slug,
        spaceId: kbArticles.spaceId,
        ownerId: kbArticles.ownerId,
        lastVerifiedAt: kbArticles.lastVerifiedAt,
        reviewIntervalDays: kbArticles.reviewIntervalDays,
      })
      .from(kbArticles)
      .where(
        and(
          eq(kbArticles.orgId, orgId),
          eq(kbArticles.status, "published"),
          isNotNull(kbArticles.reviewIntervalDays),
          sql`(${kbArticles.lastVerifiedAt} is null or ${kbArticles.lastVerifiedAt} + (${kbArticles.reviewIntervalDays} || ' days')::interval <= now())`,
        ),
      )
      .orderBy(sql`${kbArticles.lastVerifiedAt} asc nulls first`)
      .limit(100);
  }
}
