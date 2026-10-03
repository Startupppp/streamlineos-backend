import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  gte,
  isNull,
  lt,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  kbChatMessages,
  kbEvents,
  kbPageComments,
  kbPageReviews,
  kbPageVersions,
  kbPageVisits,
  kbPages,
  kbResearchBriefs,
  kbSources,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  OverviewQueryInput,
  PageAnalyticsQueryInput,
  RangeWithSpaceInput,
} from "./dto/kb-analytics.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { pageScopePredicate } from "./kb-article-page-scope";
import {
  effectiveTrustState,
  isVerifiedNow,
} from "../core/kb-page-trust-predicates";
import {
  buildTupleCursorPage,
  decodeTupleCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import { keysetInteger } from "../../../common/pagination/keyset";

export const CITATION_REUSE_MIN = 2;

export const CITATION_KINDS_ON_KB_PAGES = ["page", "article"] as const;
export const CITATION_KIND_ON_KB_SOURCES = "source";
const STALE_PAGE_THRESHOLD_DAYS = 90;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function staleCutoff(): Date {
  return new Date(
    Date.now() - STALE_PAGE_THRESHOLD_DAYS * MILLISECONDS_PER_DAY,
  );
}

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
  ticketsDeflected: number;
  verifiedPublished: number;
  trustScore: number;
};

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

export type CitationReuseRow = {
  kind: string;
  refId: number;
  title: string;
  reuseCount: number;
};

export type ReviewSlaResult = {
  decided: number;
  metSla: number;
  slaRate: number;
  overdueOpen: number;
};

function toDate(raw: string | undefined): Date | undefined {
  return raw ? new Date(raw) : undefined;
}

@Injectable()
export class KbAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async overview(
    orgId: string,
    range: OverviewQueryInput,
  ): Promise<OverviewResult> {
    const eventConditions: SQL[] = [eq(kbEvents.orgId, orgId)];
    if (range.from)
      eventConditions.push(gte(kbEvents.occurredAt, new Date(range.from)));
    if (range.to)
      eventConditions.push(lte(kbEvents.occurredAt, new Date(range.to)));
    if (range.spaceId !== undefined) {
      const spaceId = range.spaceId;
      eventConditions.push(
        sql`${kbEvents.articleId} IN (SELECT ${kbPages.id} FROM ${kbPages} WHERE ${kbPages.orgId} = ${orgId} AND ${kbPages.spaceId} = ${spaceId} AND ${kbPages.deletedAt} IS NULL)`,
      );
    }

    const pageConditions: SQL[] = [
      eq(kbPages.orgId, orgId),
      pageScopePredicate(range.scope),
    ];
    if (range.spaceId !== undefined)
      pageConditions.push(eq(kbPages.spaceId, range.spaceId));

    const [[articleStats], [eventStats]] = await Promise.all([
      this.db
        .select({
          totalCount: sql<number>`count(*)::int`,
          publishedCount: sql<number>`(count(*) filter (where ${kbPages.status} = 'published'))::int`,
          archivedCount: sql<number>`(count(*) filter (where ${kbPages.status} = 'archived'))::int`,
          totalViews: sql<number>`coalesce(sum(${kbPages.views}), 0)::int`,
          helpfulUp: sql<number>`coalesce(sum(${kbPages.helpfulCount}), 0)::int`,
          helpfulDown: sql<number>`coalesce(sum(${kbPages.notHelpfulCount}), 0)::int`,
          verifiedPublished: sql<number>`(count(*) filter (where ${kbPages.status} = 'published' and ${isVerifiedNow()}))::int`,
        })
        .from(kbPages)
        .where(and(...pageConditions)),
      this.db
        .select({
          searches: sql<number>`(count(*) filter (where ${kbEvents.eventType} in ('search', 'search_no_results')))::int`,
          noResults: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'search_no_results'))::int`,
          aiAnswers: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'ai_answer'))::int`,
          aiNoContext: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'ai_answer_no_context'))::int`,
          views: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'view'))::int`,
          ticketsDeflected: sql<number>`(count(*) filter (where ${kbEvents.eventType} = 'ticket_deflected'))::int`,
        })
        .from(kbEvents)
        .where(and(...eventConditions)),
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
    const ticketsDeflected = eventStats?.ticketsDeflected ?? 0;

    const helpfulRatio =
      helpfulUp + helpfulDown > 0 ? helpfulUp / (helpfulUp + helpfulDown) : 0;
    const searchSuccessRate =
      searches > 0 ? (searches - noResults) / searches : 0;
    const trustScore =
      publishedCount > 0 ? verifiedPublished / publishedCount : 0;

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
      ticketsDeflected,
      verifiedPublished,
      trustScore,
    };
  }

  async pages(
    user: CurrentUserContext,
    query: PageAnalyticsQueryInput = { limit: 50 },
  ): Promise<CursorPage<PageAnalyticsRow>> {
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const conditions: (SQL | undefined)[] = [
      eq(kbPages.orgId, user.orgId),
      isNull(kbPages.deletedAt),
      predicate,
    ];
    if (query.spaceId !== undefined)
      conditions.push(eq(kbPages.spaceId, query.spaceId));
    if (query.staleOnly === true)
      conditions.push(lt(kbPages.updatedAt, staleCutoff()));

    const position = decodeTupleCursor(query.cursor, 2);
    const havingConditions: SQL[] = [];
    if (position) {
      const afterCount = keysetInteger(position[0] ?? "");
      const afterId = keysetInteger(position[1] ?? "");
      havingConditions.push(
        sql`(count(distinct ${kbPageVisits.id}), ${kbPages.id}) < (${sql.param(afterCount)}, ${sql.param(afterId, kbPages.id)})`,
      );
    }

    const rows = await this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        status: kbPages.status,
        trustState: effectiveTrustState(),
        updatedAt: kbPages.updatedAt,
        uniqueViewers: sql<number>`count(distinct ${kbPageVisits.id})::int`,
        commentCount: sql<number>`count(distinct ${kbPageComments.id})::int`,
        versionCount: sql<number>`count(distinct ${kbPageVersions.id})::int`,
      })
      .from(kbPages)
      .leftJoin(
        kbPageVisits,
        and(
          eq(kbPageVisits.pageId, kbPages.id),
          eq(kbPageVisits.orgId, user.orgId),
        ),
      )
      .leftJoin(
        kbPageComments,
        and(
          eq(kbPageComments.pageId, kbPages.id),
          eq(kbPageComments.orgId, user.orgId),
        ),
      )
      .leftJoin(
        kbPageVersions,
        and(
          eq(kbPageVersions.pageId, kbPages.id),
          eq(kbPageVersions.orgId, user.orgId),
        ),
      )
      .where(and(...conditions))
      .groupBy(kbPages.id)
      .having(
        havingConditions.length > 0 ? and(...havingConditions) : undefined,
      )
      .orderBy(desc(sql`count(distinct ${kbPageVisits.id})`), desc(kbPages.id))
      .limit(query.limit + 1);

    return buildTupleCursorPage(rows, query.limit, (row) => [
      String(row.uniqueViewers),
      String(row.id),
    ]);
  }

  async citationReuse(
    user: CurrentUserContext,
    range: RangeWithSpaceInput,
  ): Promise<CitationReuseRow[]> {
    const orgId = user.orgId;
    const [visiblePage, standing] = await Promise.all([
      this.auth.visiblePagePredicate(user, "view"),
      this.auth.resolveStanding(user),
    ]);
    const messageFrom = toDate(range.from);
    const messageTo = toDate(range.to);
    const pageKinds = sql.join(
      CITATION_KINDS_ON_KB_PAGES.map((kind) => sql`${kind}`),
      sql`, `,
    );
    const sourceSpaceFence =
      standing.accessibleSpaceIds.length > 0
        ? sql`(${kbSources.spaceId} IS NULL OR ${kbSources.spaceId} IN (${sql.join(
            standing.accessibleSpaceIds.map((id) => sql`${id}`),
            sql`, `,
          )}))`
        : sql`${kbSources.spaceId} IS NULL`;
    const rows = await this.db.execute(sql`
      WITH cited AS (
        SELECT
          elem->>'kind' AS kind,
          COALESCE(
            (elem->>'pageId')::int,
            (elem->>'articleId')::int,
            (elem->>'sourceId')::int,
            (elem->>'linkedDocumentId')::int
          ) AS ref_id,
          elem->>'title' AS title
        FROM ${kbChatMessages} m
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(m.citations) = 'array' THEN m.citations
            ELSE '[]'::jsonb
          END
        ) AS elem
        WHERE m.org_id = ${orgId} AND m.citations IS NOT NULL
          ${messageFrom ? sql`AND m.created_at >= ${messageFrom.toISOString()}::timestamptz` : sql``}
          ${messageTo ? sql`AND m.created_at <= ${messageTo.toISOString()}::timestamptz` : sql``}
        UNION ALL
        SELECT
          c->>'kind' AS kind,
          (c->>'id')::int AS ref_id,
          c->>'title' AS title
        FROM ${kbResearchBriefs} b
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(b.citations) = 'array' THEN b.citations
            ELSE '[]'::jsonb
          END
        ) AS c
        WHERE b.org_id = ${orgId} AND b.citations IS NOT NULL
          ${messageFrom ? sql`AND b.created_at >= ${messageFrom.toISOString()}::timestamptz` : sql``}
          ${messageTo ? sql`AND b.created_at <= ${messageTo.toISOString()}::timestamptz` : sql``}
      )
      SELECT kind, ref_id, min(title) AS title, count(*)::int AS reuse_count
      FROM cited
      WHERE ref_id IS NOT NULL
        AND (
          (
            kind IN (${pageKinds})
            AND EXISTS (
              SELECT 1
              FROM ${kbPages}
              WHERE ${kbPages.orgId} = ${orgId}
                AND ${kbPages.id} = cited.ref_id
                AND ${kbPages.deletedAt} IS NULL
                AND ${visiblePage}
                ${range.spaceId !== undefined ? sql`AND ${kbPages.spaceId} = ${range.spaceId}` : sql``}
            )
          )
          OR (
            kind = ${CITATION_KIND_ON_KB_SOURCES}
            AND EXISTS (
              SELECT 1
              FROM ${kbSources}
              WHERE ${kbSources.orgId} = ${orgId}
                AND ${kbSources.id} = cited.ref_id
                AND ${kbSources.deletedAt} IS NULL
                AND ${kbSources.status} = 'ready'
                AND ${sourceSpaceFence}
                ${range.spaceId !== undefined ? sql`AND (${kbSources.spaceId} IS NULL OR ${kbSources.spaceId} = ${range.spaceId})` : sql``}
            )
          )
        )
      GROUP BY kind, ref_id
      HAVING count(*) >= ${CITATION_REUSE_MIN}
      ORDER BY reuse_count DESC
      LIMIT 100
    `);

    return rows.map((row) => ({
      kind: typeof row.kind === "string" ? row.kind : "",
      refId: Number(row.ref_id),
      title: typeof row.title === "string" ? row.title : "",
      reuseCount: Number(row.reuse_count),
    }));
  }

  async reviewSla(
    orgId: string,
    range: RangeWithSpaceInput,
  ): Promise<ReviewSlaResult> {
    const decidedConditions: SQL[] = [
      eq(kbPageReviews.orgId, orgId),
      sql`${kbPageReviews.status} != 'pending'`,
      sql`${kbPageReviews.dueAt} IS NOT NULL`,
    ];
    if (range.from)
      decidedConditions.push(
        gte(kbPageReviews.decidedAt, new Date(range.from)),
      );
    if (range.to)
      decidedConditions.push(lte(kbPageReviews.decidedAt, new Date(range.to)));

    const overdueConditions: SQL[] = [
      eq(kbPageReviews.orgId, orgId),
      eq(kbPageReviews.status, "pending"),
      lt(kbPageReviews.dueAt, new Date()),
    ];

    if (range.spaceId !== undefined) {
      const spaceId = range.spaceId;
      decidedConditions.push(
        sql`${kbPageReviews.pageId} IN (SELECT ${kbPages.id} FROM ${kbPages} WHERE ${kbPages.orgId} = ${orgId} AND ${kbPages.spaceId} = ${spaceId} AND ${kbPages.deletedAt} IS NULL)`,
      );
      overdueConditions.push(
        sql`${kbPageReviews.pageId} IN (SELECT ${kbPages.id} FROM ${kbPages} WHERE ${kbPages.orgId} = ${orgId} AND ${kbPages.spaceId} = ${spaceId} AND ${kbPages.deletedAt} IS NULL)`,
      );
    }

    const [[decidedStats], [overdueStats]] = await Promise.all([
      this.db
        .select({
          decided: sql<number>`count(*)::int`,
          metSla: sql<number>`(count(*) filter (where ${kbPageReviews.decidedAt} <= ${kbPageReviews.dueAt}))::int`,
        })
        .from(kbPageReviews)
        .where(and(...decidedConditions)),
      this.db
        .select({ overdueOpen: sql<number>`count(*)::int` })
        .from(kbPageReviews)
        .where(and(...overdueConditions)),
    ]);

    const decided = decidedStats?.decided ?? 0;
    const metSla = decidedStats?.metSla ?? 0;

    return {
      decided,
      metSla,
      slaRate: decided > 0 ? metSla / decided : 0,
      overdueOpen: overdueStats?.overdueOpen ?? 0,
    };
  }
}
