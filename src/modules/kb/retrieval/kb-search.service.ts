import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { KbSearchMetrics, KB_SEARCH_QUEUE_LANE } from "../core/telemetry/kb-search-metrics";
import { PROCESS_CELL_ID } from "../../../common/cell-resources/cell-id";
import { kbArticleChunks, kbPages, kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { KbEventsService } from "../core/kb-events.service";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { SearchInput } from "./dto/kb-ai.schemas";
import type { ScopedRead } from "../../access/scoped-read";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { KbCandidateService } from "./kb-candidate.service";
import { supportArticlePredicate, wikiPagePredicate } from "../help-centre/kb-article-page-scope";
import { AccessService } from "../../access/access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  articleOwnerScope,
  articleOwnerScopeFilter,
} from "./kb-article-owner-scope";
import {
  kbDocumentKey,
  KB_ASK_CONTEXT_BUDGET,
  KB_ASK_MAX_CONTEXT_DOCUMENTS,
  type KbContextPassage,
} from "./kb-ask-context";

const KB_SEARCH_FEATURE = "kb.search";

export const KB_DOCUMENT_PASSAGE_ROWS =
  KB_ASK_MAX_CONTEXT_DOCUMENTS * KB_ASK_CONTEXT_BUDGET.maxPassagesPerDocument;

export type RetrievedSource =
  | {
      kind: "article";
      id: number;
      title: string;
      slug: string;
      spaceId: number | null;
      contentText: string;
      updatedAt: Date;
    }
  | {
      kind: "page";
      id: number;
      title: string;
      spaceId: number | null;
      contentText: string;
      updatedAt: Date;
    };

export interface RetrievedSourceDocument {
  sourceId: number;
  title: string;
  spaceId: number | null;
  updatedAt: Date;
  passages: KbContextPassage[];
  degraded?: true;
}

export type DegradableContextPassage = KbContextPassage & { degraded?: true };

export interface QueryEmbedding {
  readonly vectorLiteral: string | null;
}

export function normalizeEmbeddableQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

@Injectable()
export class KbSearchService {
  private readonly logger = new Logger(KbSearchService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly aiGateway: AiGatewayService,
    private readonly events: KbEventsService,
    private readonly candidates: KbCandidateService,
    private readonly scopes: AccessService,
    private readonly auth: KnowledgeAuthorizationService,
    @Optional()
    @Inject(CacheService)
    private readonly cache: CacheService | null = null,
  ) {}

  async articleOwnerFilterFor(user: CurrentUserContext): Promise<SQL> {
    const read = await resolveKbArticlesViewScope(this.scopes, user);
    return articleOwnerScopeFilter(read, user);
  }

  private queryEmbeddingCacheKey(text: string): string {
    return CACHE_KEYS.kbQueryEmbedding(
      EMBEDDING_MODEL,
      createHash("sha256").update(normalizeEmbeddableQuery(text)).digest("hex"),
    );
  }

  private async embedOrDegrade(
    text: string,
    orgId: string,
  ): Promise<string | null> {
    const cache = this.cache;
    if (cache === null) return this.embedCharged(text, orgId);
    const key = this.queryEmbeddingCacheKey(text);
    const hit = await cache.get<string>(key);
    if (hit !== null) return hit;
    const vectorLiteral = await this.embedCharged(text, orgId);
    if (vectorLiteral !== null)
      await cache.set(key, vectorLiteral, CACHE_TTL.HOUR);
    return vectorLiteral;
  }

  async resolveQueryEmbedding(
    query: string,
    orgId: string,
  ): Promise<QueryEmbedding> {
    const q = query.trim();
    if (q.length === 0 || !this.aiGateway.isEmbeddingConfigured())
      return { vectorLiteral: null };
    return { vectorLiteral: await this.embedOrDegrade(q, orgId) };
  }

  private async vectorFor(
    query: string,
    orgId: string,
    embedding: QueryEmbedding | undefined,
  ): Promise<string | null> {
    if (embedding !== undefined) return embedding.vectorLiteral;
    if (!this.aiGateway.isEmbeddingConfigured()) return null;
    return this.embedOrDegrade(query, orgId);
  }

  private async embedCharged(
    text: string,
    orgId: string,
  ): Promise<string | null> {
    try {
      const embedResult = await this.aiGateway.embedQueryWithCredit({
        text,
        orgId,
        feature: KB_SEARCH_FEATURE,
        charge: true,
      });
      if (embedResult.ok) return embedResult.vectorLiteral;
      this.logger.warn(
        "KB semantic search embedding unavailable — keyword only",
        {
          orgId,
          kind: embedResult.kind,
        },
      );
      return null;
    } catch (err: unknown) {
      logSideEffectFailure("kb semantic search embedding", { orgId })(err);
      return null;
    }
  }

  private chunkKeywordRank(text: string): SQL<number> {
    return sql<number>`ts_rank(to_tsvector('english', ${kbArticleChunks.content}), websearch_to_tsquery('english', ${text}))`;
  }

  private chunkKeywordMatch(text: string): SQL {
    return sql`to_tsvector('english', ${kbArticleChunks.content}) @@ websearch_to_tsquery('english', ${text})`;
  }

  async aclCacheOutcome(user: CurrentUserContext): Promise<"hit" | "miss" | "bypass"> {
    const { cacheOutcome } = await this.access.getAccessibleSpaceIdsWithCacheOutcome(user);
    return cacheOutcome;
  }

  async search(
    user: CurrentUserContext,
    input: SearchInput,
    scope: ScopedRead,
  ): Promise<{
    items: {
      id: number;
      spaceId: number | null;
      categoryId: number | null;
      title: string;
      slug: string;
      excerpt: string | null;
      status: "draft" | "in_review" | "published" | "archived";
      updatedAt: Date;
      snippet: string;
    }[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const metrics = KbSearchMetrics.begin({ orgId: user.orgId, actorStanding: user.isOrgOwner ? "owner" : "member", orgCell: PROCESS_CELL_ID });
    try {
      return await runInTenantTransaction(
        this.db,
        () => this.searchMeasured(user, input, scope, metrics),
        { orgId: user.orgId },
      );
    } catch (error) {
      metrics.finish("error");
      throw error;
    }
  }

  private async searchMeasured(
    user: CurrentUserContext,
    input: SearchInput,
    scope: ScopedRead,
    metrics: KbSearchMetrics,
  ): Promise<{
    items: {
      id: number;
      spaceId: number | null;
      categoryId: number | null;
      title: string;
      slug: string;
      excerpt: string | null;
      status: "draft" | "in_review" | "published" | "archived";
      updatedAt: Date;
      snippet: string;
    }[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const empty = {
      items: [],
      total: 0,
      page: input.page,
      pageSize: input.pageSize,
      totalPages: 0,
    };
    const dbRole = "primary";
    const queueLane = KB_SEARCH_QUEUE_LANE;
    const emptyKind = "none";
    if (scope.denied) {
      const scopeDeniedOutcome = "bypass";
      metrics.finish("denied", { sourceKind: emptyKind, cacheOutcome: scopeDeniedOutcome, queueLane, dbRole });
      return empty;
    }

    const { spaceIds: ids, cacheOutcome } = await this.access.getAccessibleSpaceIdsWithCacheOutcome(user);
    if (ids.length === 0) {
      metrics.finish("not_found", { sourceKind: emptyKind, cacheOutcome, queueLane, dbRole });
      return empty;
    }

    const tsquery = sql`websearch_to_tsquery('english', ${input.q})`;
    const keywordCond = await this.candidates.resolveArticleKeywordCondition(
      input.q,
      tsquery,
      500,
    );
    const domain: SQL[] = [
      supportArticlePredicate(),
      inArray(kbPages.spaceId, ids),
      ne(kbPages.status, "archived"),
      keywordCond,
    ];
    const articleRestriction = await this.auth.articleRestrictionPredicate(user);
    if (articleRestriction) domain.push(articleRestriction);
    if (input.spaceId) domain.push(eq(kbPages.spaceId, input.spaceId));
    const membershipId =
      user.principal === undefined ? null : actingMembershipId(user.principal);
    const where = scope.compose(
      {
        tenant: kbPages.orgId,
        scope: articleOwnerScope(membershipId),
        and: domain,
      },
      ({ sql: composed }) => composed,
      () => sql`false`,
    );

    const offset = (input.page - 1) * input.pageSize;

    const rows = await this.db
      .select({
        id: kbPages.id,
        spaceId: kbPages.spaceId,
        categoryId: kbPages.categoryId,
        title: kbPages.title,
        slug: kbPages.slug,
        excerpt: kbPages.excerpt,
        status: kbPages.status,
        updatedAt: kbPages.updatedAt,
        contentText: kbPages.contentText,
      })
      .from(kbPages)
      .where(where)
      .orderBy(
        desc(this.candidates.keywordRank(tsquery)),
        desc(kbPages.updatedAt),
      )
      .limit(input.pageSize)
      .offset(offset);

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbPages)
      .where(where);
    const total = countRow?.count ?? 0;

    const items = rows.map(({ contentText, slug, ...card }) => ({
      ...card,
      slug: slug ?? "",
      snippet: this.candidates.buildSnippet(contentText, input.q),
    }));

    await this.events.recordDetached(
      user.orgId,
      total > 0 ? "search" : "search_no_results",
      {
        actorMembershipId: actingMembershipId(user.principal) ?? null,
        query: input.q,
        metadata: { resultsCount: total },
      },
    );

    const sourceKind = "article";
    metrics.finish(total > 0 ? "found" : "not_found", { results: total, sourceKind, cacheOutcome, queueLane, dbRole });
    return {
      items,
      total,
      page: input.page,
      pageSize: input.pageSize,
      totalPages: Math.ceil(total / input.pageSize),
    };
  }

  async retrieveTopArticles(
    user: CurrentUserContext,
    query: string,
    limit: number,
    spaceId?: number,
    verifiedOnly?: boolean,
    embedding?: QueryEmbedding,
  ): Promise<RetrievedSource[]> {
    const ids = await this.access.getAccessibleSpaceIds(user);
    const q = query.trim();
    if (!q) return [];

    const principal = await this.access.getPrincipalIds(user);
    const ownerFilter = await this.articleOwnerFilterFor(user);

    const pool = Math.max(limit * 3, limit);
    const hasSpaces = ids.length > 0;

    let vectorLiteral: string | null = null;
    if (
      this.aiGateway.isEmbeddingConfigured() &&
      (await this.candidates.hasEmbeddedChunks(user.orgId))
    ) {
      vectorLiteral = await this.vectorFor(q, user.orgId, embedding);
    }

    const standing = await this.auth.resolveStanding(user);
    const pageVisibility = buildVisiblePageScope(standing, "view").predicate;

    const [articleKeyword, articleVector, pageKeyword, pageVector] =
      await Promise.all([
        hasSpaces
          ? this.candidates.articleKeywordCandidates(
              user.orgId,
              ids,
              q,
              pool,
              principal,
              ownerFilter,
              spaceId,
            )
          : Promise.resolve<number[]>([]),
        hasSpaces && vectorLiteral
          ? this.candidates.articleVectorCandidates(
              user.orgId,
              ids,
              vectorLiteral,
              pool,
              principal,
              ownerFilter,
              spaceId,
            )
          : Promise.resolve<number[]>([]),
        this.candidates.pageKeywordCandidates(
          user.orgId,
          q,
          pool,
          pageVisibility,
          verifiedOnly,
        ),
        vectorLiteral
          ? this.candidates.pageVectorCandidates(
              user.orgId,
              vectorLiteral,
              pool,
              chunkVisibleTo(standing),
              verifiedOnly,
            )
          : Promise.resolve<number[]>([]),
      ]);

    const lists: string[][] = [];
    if (articleKeyword.length > 0)
      lists.push(articleKeyword.map((id) => `a:${id}`));
    if (articleVector.length > 0)
      lists.push(articleVector.map((id) => `a:${id}`));
    if (pageKeyword.length > 0) lists.push(pageKeyword.map((id) => `p:${id}`));
    if (pageVector.length > 0) lists.push(pageVector.map((id) => `p:${id}`));

    const fused = this.candidates.fuseKeys(lists).slice(0, limit);
    if (fused.length === 0) return [];

    const articleIds = fused
      .filter((k) => k.startsWith("a:"))
      .map((k) => parseInt(k.slice(2), 10));
    const pageIds = fused
      .filter((k) => k.startsWith("p:"))
      .map((k) => parseInt(k.slice(2), 10));

    const results: RetrievedSource[] = [];

    if (articleIds.length > 0) {
      const articleConditions: SQL[] = [
        eq(kbPages.orgId, user.orgId),
        inArray(kbPages.id, articleIds),
        supportArticlePredicate(),
        eq(kbPages.status, "published"),
      ];
      if (spaceId) articleConditions.push(eq(kbPages.spaceId, spaceId));
      if (ownerFilter) articleConditions.push(ownerFilter);
      const articleRestriction = await this.auth.articleRestrictionPredicate(user);
      if (articleRestriction) articleConditions.push(articleRestriction);
      const articleRows = await this.db
        .select({
          id: kbPages.id,
          title: kbPages.title,
          slug: kbPages.slug,
          spaceId: kbPages.spaceId,
          contentText: kbPages.contentText,
          updatedAt: kbPages.updatedAt,
        })
        .from(kbPages)
        .where(and(...articleConditions));
      for (const row of articleRows) {
        results.push({
          kind: "article",
          ...row,
          slug: row.slug ?? "",
          contentText: row.contentText ?? "",
        });
      }
    }

    if (pageIds.length > 0) {
      const pageRows = await this.db
        .select({
          id: kbPages.id,
          title: kbPages.title,
          spaceId: kbPages.spaceId,
          contentText: kbPages.contentText,
          updatedAt: kbPages.updatedAt,
        })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, user.orgId),
            inArray(kbPages.id, pageIds),
            wikiPagePredicate(),
            ne(kbPages.status, "archived"),
            pageVisibility,
          ),
        );
      for (const row of pageRows) {
        results.push({
          kind: "page",
          ...row,
          contentText: row.contentText ?? "",
        });
      }
    }

    const order = new Map(fused.map((key, index) => [key, index]));
    return results.sort((a, b) => {
      const ka = a.kind === "article" ? `a:${a.id}` : `p:${a.id}`;
      const kb = b.kind === "article" ? `a:${b.id}` : `p:${b.id}`;
      return (order.get(ka) ?? 0) - (order.get(kb) ?? 0);
    });
  }

  private async articlePassageScope(
    user: CurrentUserContext,
    articleIds: number[],
  ): Promise<SQL[]> {
    const [ownerFilter, restrictionFilter] = await Promise.all([
      this.articleOwnerFilterFor(user),
      this.auth.articleRestrictionPredicate(user),
    ]);
    const conditions: SQL[] = [
      inArray(kbArticleChunks.pageId, articleIds),
      supportArticlePredicate(),
      eq(kbPages.status, "published"),
    ];
    if (ownerFilter) conditions.push(ownerFilter);
    if (restrictionFilter) conditions.push(restrictionFilter);
    return conditions;
  }

  async retrieveDocumentPassages(
    user: CurrentUserContext,
    query: string,
    articleIds: number[],
    pageIds: number[] = [],
    embedding?: QueryEmbedding,
  ): Promise<DegradableContextPassage[]> {
    if (articleIds.length === 0 && pageIds.length === 0) return [];
    try {
      const vector = await this.vectorFor(query, user.orgId, embedding);
      const ordering: SQL[] =
        vector === null
          ? [
              desc(this.chunkKeywordRank(query)),
              asc(kbArticleChunks.chunkIndex),
            ]
          : [sql`${kbArticleChunks.embedding} <=> ${vector}::vector`];
      const scope: SQL[] = [];
      if (articleIds.length > 0) {
        const articleScope = and(
          ...(await this.articlePassageScope(user, articleIds)),
        );
        if (articleScope) scope.push(articleScope);
      }
      if (pageIds.length > 0) {
        const pagePredicate = await this.auth.visiblePagePredicate(
          user,
          "view",
        );
        const pageScope = and(
          inArray(kbArticleChunks.pageId, pageIds),
          wikiPagePredicate(),
          pagePredicate,
        );
        if (pageScope) scope.push(pageScope);
      }
      const rows = await this.db
        .select({
          content: kbArticleChunks.content,
          chunkIndex: kbArticleChunks.chunkIndex,
          pageId: kbArticleChunks.pageId,
          title: kbPages.title,
        })
        .from(kbArticleChunks)
        .innerJoin(
          kbPages,
          and(
            eq(kbPages.id, kbArticleChunks.pageId),
            eq(kbPages.orgId, kbArticleChunks.orgId),
            eq(kbArticleChunks.aclRevision, kbPages.aclRevision),
          ),
        )
        .where(and(eq(kbArticleChunks.orgId, user.orgId), or(...scope)))
        .orderBy(...ordering)
        .limit(Math.min(KB_DOCUMENT_PASSAGE_ROWS, PAGE_SIZE_CAP));
      const degraded = vector === null ? { degraded: true as const } : {};
      const askedAsArticle = new Set(articleIds);
      return rows.flatMap<DegradableContextPassage>((row) => {
        if (row.pageId === null) return [];
        return [
          {
            documentKey: kbDocumentKey(
              askedAsArticle.has(row.pageId) ? "article" : "page",
              row.pageId,
            ),
            documentTitle: row.title,
            passageIndex: row.chunkIndex,
            text: row.content,
            ...degraded,
          },
        ];
      });
    } catch (err) {
      this.logger.warn("KB document passage retrieval failed", {
        orgId: user.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async retrieveTopSources(
    user: CurrentUserContext,
    query: string,
    limit: number,
    sourceIds?: number[],
    embedding?: QueryEmbedding,
  ): Promise<RetrievedSourceDocument[]> {
    const q = query.trim();
    if (!q) return [];
    if (!(await this.candidates.hasEmbeddedChunks(user.orgId))) return [];
    try {
      const accessibleSpaceIds = await this.access.getAccessibleSpaceIds(user);
      const vector = await this.vectorFor(q, user.orgId, embedding);

      const cap = Math.min(limit * 4, PAGE_SIZE_CAP);
      const chunkIds =
        vector === null
          ? []
          : await this.candidates.vectorChunkIds(user.orgId, vector, cap);
      if (vector !== null && chunkIds.length === 0) return [];

      const spaceFilter =
        accessibleSpaceIds.length > 0
          ? or(
              isNull(kbSources.spaceId),
              inArray(kbSources.spaceId, accessibleSpaceIds),
            )
          : isNull(kbSources.spaceId);

      const conditions: SQL[] = [
        eq(kbArticleChunks.orgId, user.orgId),
        eq(kbArticleChunks.source, "source"),
        isNull(kbSources.deletedAt),
        eq(kbSources.status, "ready"),
        eq(kbSources.orgId, user.orgId),
      ];
      if (spaceFilter) conditions.push(spaceFilter);
      if (sourceIds && sourceIds.length > 0) conditions.push(inArray(kbSources.id, sourceIds));
      if (vector === null) conditions.push(this.chunkKeywordMatch(q));
      else conditions.push(inArray(kbArticleChunks.id, chunkIds));

      const ordering =
        vector === null
          ? desc(this.chunkKeywordRank(q))
          : sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;

      const rows = await this.db
        .select({
          sourceId: kbSources.id,
          title: kbSources.title,
          spaceId: kbSources.spaceId,
          updatedAt: kbSources.updatedAt,
          content: kbArticleChunks.content,
          chunkIndex: kbArticleChunks.chunkIndex,
        })
        .from(kbArticleChunks)
        .innerJoin(kbSources, eq(kbSources.id, kbArticleChunks.sourceId))
        .where(and(...conditions))
        .orderBy(ordering)
        .limit(cap);

      const degraded = vector === null ? { degraded: true as const } : {};
      const byId = new Map<number, RetrievedSourceDocument>();
      for (const row of rows) {
        const existing = byId.get(row.sourceId);
        if (existing === undefined && byId.size >= limit) continue;
        const document = existing ?? {
          sourceId: row.sourceId,
          title: row.title,
          spaceId: row.spaceId,
          updatedAt: row.updatedAt,
          passages: [],
          ...degraded,
        };
        document.passages.push({
          documentKey: kbDocumentKey("source", row.sourceId),
          documentTitle: row.title,
          passageIndex: row.chunkIndex,
          text: row.content,
        });
        if (existing === undefined) byId.set(row.sourceId, document);
      }
      return [...byId.values()];
    } catch (err) {
      this.logger.warn("KB top-source retrieval failed", {
        orgId: user.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
