import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { kbEvents, kbPageComments, kbPageVersions, kbPageVisits, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { RangeInput } from "./dto/kb-analytics.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { supportArticlePredicate } from "./kb-article-page-scope";

type TopArticle = {
  id: number;
  title: string;
  slug: string;
  spaceId: number | null;
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
};

type OverviewResult = {
  totalCount: number;
  publishedCount: number;
  archivedCount: number;
  totalViews: number;
  helpfulUp: number;
  helpfulDown: number;
  helpfulRatio: number;
  searches: number;
  noResults: number;
  searchSuccessRate: number;
  aiAnswers: number;
  aiNoContext: number;
  views: number;
  verifiedPublished: number;
  trustScore: number;
  topArticles: TopArticle[];
};

type ContentGapRow = {
  query: string | null;
  count: number;
  lastOccurredAt: Date;
  gapKind: "search" | "ai_no_context";
};

type NoResultsRow = { query: string | null; count: number };

type PageAnalyticsRow = {
  id: number;
  title: string;
  status: string;
  trustState: string;
  updatedAt: Date;
  uniqueViewers: number;
  commentCount: number;
  versionCount: number;
};

type GapRow = {
  query: string | null;
  count: number;
  lastOccurredAt: Date;
};

@Injectable()
export class KbAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async overview(orgId: string, range: RangeInput): Promise<OverviewResult> {
    const eventConditions: SQL[] = [eq(kbEvents.orgId, orgId)];
    if (range.from) eventConditions.push(gte(kbEvents.occurredAt, new Date(range.from)));
    if (range.to) eventConditions.push(lte(kbEvents.occurredAt, new Date(range.to)));

    const [[articleStats], [eventStats], topArticles] = await Promise.all([
      this.db
        .select({
          totalCount: sql<number>`count(*)::int`,
          publishedCount: sql<number>`(count(*) filter (where ${kbPages.status} = 'published'))::int`,
          archivedCount: sql<number>`(count(*) filter (where ${kbPages.status} = 'archived'))::int`,
          totalViews: sql<number>`coalesce(sum(${kbPages.views}), 0)::int`,
          helpfulUp: sql<number>`coalesce(sum(${kbPages.helpfulCount}), 0)::int`,
          helpfulDown: sql<number>`coalesce(sum(${kbPages.notHelpfulCount}), 0)::int`,
          verifiedPublished: sql<number>`(count(*) filter (where ${kbPages.status} = 'published' and ${kbPages.trustState} = 'verified' and (${kbPages.verifiedUntil} is null or ${kbPages.verifiedUntil} >= now())))::int`,
        })
        .from(kbPages)
        .where(and(eq(kbPages.orgId, orgId), supportArticlePredicate())),
      this.db
        .select({
          searches: sql<number>`(count(*) filter (where ${kbEvents.eventType} in ('search', 'search_no_results')))::int`,
          noResults: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'search_no_results'))::int`,
          aiAnswers: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'ai_answer'))::int`,
          aiNoContext: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'ai_answer_no_context'))::int`,
          views: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'view'))::int`,
        })
        .from(kbEvents)
        .where(and(...eventConditions)),
      this.db
        .select({
          id: kbPages.id,
          title: kbPages.title,
          slug: sql<string>`coalesce(${kbPages.slug}, '')`,
          spaceId: kbPages.spaceId,
          viewCount: sql<number>`coalesce(${kbPages.views}, 0)::int`,
          helpfulCount: sql<number>`coalesce(${kbPages.helpfulCount}, 0)::int`,
          notHelpfulCount: sql<number>`coalesce(${kbPages.notHelpfulCount}, 0)::int`,
        })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            supportArticlePredicate(),
            eq(kbPages.status, "published"),
          ),
        )
        .orderBy(desc(sql`coalesce(${kbPages.views}, 0)`))
        .limit(10),
    ]);

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
    const aiNoContext = eventStats?.aiNoContext ?? 0;
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
      aiNoContext,
      views,
      verifiedPublished,
      trustScore,
      topArticles,
    };
  }

  async pages(user: CurrentUserContext): Promise<PageAnalyticsRow[]> {
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    return this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        status: kbPages.status,
        trustState: kbPages.trustState,
        updatedAt: kbPages.updatedAt,
        uniqueViewers: sql<number>`count(distinct ${kbPageVisits.id})::int`,
        commentCount: sql<number>`count(distinct ${kbPageComments.id})::int`,
        versionCount: sql<number>`count(distinct ${kbPageVersions.id})::int`,
      })
      .from(kbPages)
      .leftJoin(kbPageVisits, eq(kbPageVisits.pageId, kbPages.id))
      .leftJoin(
        kbPageComments,
        and(eq(kbPageComments.pageId, kbPages.id), eq(kbPageComments.orgId, user.orgId)),
      )
      .leftJoin(
        kbPageVersions,
        and(eq(kbPageVersions.pageId, kbPages.id), eq(kbPageVersions.orgId, user.orgId)),
      )
      .where(and(eq(kbPages.orgId, user.orgId), isNull(kbPages.deletedAt), predicate))
      .groupBy(kbPages.id)
      .orderBy(desc(sql`count(distinct ${kbPageVisits.id})`))
      .limit(50);
  }

  async gaps(orgId: string, range: RangeInput): Promise<GapRow[]> {
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
        lastOccurredAt: sql<Date>`max(${kbEvents.occurredAt})`,
      })
      .from(kbEvents)
      .where(and(...conditions))
      .groupBy(kbEvents.query)
      .orderBy(desc(sql`count(*)`))
      .limit(50);
  }

  async noResults(orgId: string, range: RangeInput): Promise<NoResultsRow[]> {
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

  async contentGaps(orgId: string, range: RangeInput): Promise<ContentGapRow[]> {
    const conditions: SQL[] = [
      eq(kbEvents.orgId, orgId),
      inArray(kbEvents.eventType, ["search_no_results", "ai_answer_no_context"]),
    ];
    if (range.from) conditions.push(gte(kbEvents.occurredAt, new Date(range.from)));
    if (range.to) conditions.push(lte(kbEvents.occurredAt, new Date(range.to)));

    const rows = await this.db
      .select({
        query: kbEvents.query,
        eventType: kbEvents.eventType,
        count: sql<number>`count(*)::int`,
        lastOccurredAt: sql<Date>`max(${kbEvents.occurredAt})`,
      })
      .from(kbEvents)
      .where(and(...conditions))
      .groupBy(kbEvents.query, kbEvents.eventType)
      .orderBy(desc(sql`count(*)`))
      .limit(100);

    return rows.map((row) => ({
      query: row.query,
      count: row.count,
      lastOccurredAt: row.lastOccurredAt,
      gapKind: row.eventType === "ai_answer_no_context" ? ("ai_no_context" as const) : ("search" as const),
    }));
  }

}
