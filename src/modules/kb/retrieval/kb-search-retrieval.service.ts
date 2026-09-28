import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
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
import { kbArticleChunks, kbPages, kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { KbCandidateService } from "./kb-candidate.service";
import {
  supportArticlePredicate,
  wikiPagePredicate,
} from "../help-centre/kb-article-page-scope";
import { AccessService } from "../../access/access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
import {
  articleOwnerScope,
  resolveArticleOwnerFilter,
} from "./kb-article-owner-scope";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import {
  kbDocumentKey,
  KB_ASK_CONTEXT_BUDGET,
  KB_ASK_MAX_CONTEXT_DOCUMENTS,
  type KbContextPassage,
} from "./kb-ask-context";
import {
  KbEmbeddingCache,
  normalizeEmbeddableQuery,
} from "./kb-embedding-cache";
import type { KbPageStatus } from "../core/collection/knowledge-collection.types";

export { normalizeEmbeddableQuery };

export type RetrievalChannelKind =
  | "ok"
  | "empty"
  | "disabled"
  | "degraded"
  | "failed";

export interface RetrievalChannelOutcome<T> {
  kind: RetrievalChannelKind;
  results: T[];
}

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
      aclRevision?: number;
    }
  | {
      kind: "page";
      id: number;
      title: string;
      spaceId: number | null;
      contentText: string;
      updatedAt: Date;
      aclRevision?: number;
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

@Injectable()
export class KbSearchRetrievalService {
  private readonly logger = new Logger(KbSearchRetrievalService.name);
  private readonly embeddingCache: KbEmbeddingCache;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly candidates: KbCandidateService,
    private readonly scopes: AccessService,
    private readonly auth: KnowledgeAuthorizationService,
    @Optional()
    @Inject(CacheService)
    private readonly cache: CacheService | null = null,
  ) {
    this.embeddingCache = new KbEmbeddingCache(aiGateway, cache);
  }

  async resolveQueryEmbedding(
    query: string,
    orgId: string,
  ): Promise<QueryEmbedding> {
    const q = query.trim();
    if (q.length === 0 || !this.aiGateway.isEmbeddingConfigured())
      return { vectorLiteral: null };
    return {
      vectorLiteral: await this.embeddingCache.embedOrDegrade(q, orgId),
    };
  }

  private async vectorFor(
    query: string,
    orgId: string,
    embedding: QueryEmbedding | undefined,
  ): Promise<string | null> {
    if (embedding !== undefined) return embedding.vectorLiteral;
    if (!this.aiGateway.isEmbeddingConfigured()) return null;
    return this.embeddingCache.embedOrDegrade(query, orgId);
  }

  async articleOwnerFilterFor(user: CurrentUserContext): Promise<SQL> {
    return resolveArticleOwnerFilter(this.scopes, user);
  }

  private chunkKeywordRank(text: string): SQL<number> {
    return sql<number>`ts_rank(to_tsvector('english', ${kbArticleChunks.content}), websearch_to_tsquery('english', ${text}))`;
  }

  private chunkKeywordMatch(text: string): SQL {
    return sql`to_tsvector('english', ${kbArticleChunks.content}) @@ websearch_to_tsquery('english', ${text})`;
  }

  async retrieveTopArticles(
    user: CurrentUserContext,
    query: string,
    limit: number,
    spaceId?: number,
    verifiedOnly?: boolean,
    embedding?: QueryEmbedding,
    pageIds?: number[],
    ownerMembershipId?: number,
    status?: KbPageStatus,
  ): Promise<RetrievedSource[]> {
    const { results } = await this.retrieveTopArticlesWithOutcome(
      user,
      query,
      limit,
      spaceId,
      verifiedOnly,
      embedding,
      pageIds,
      ownerMembershipId,
      status,
    );
    return results;
  }

  async retrieveTopArticlesWithOutcome(
    user: CurrentUserContext,
    query: string,
    limit: number,
    spaceId?: number,
    verifiedOnly?: boolean,
    embedding?: QueryEmbedding,
    pageIds?: number[],
    ownerMembershipId?: number,
    status?: KbPageStatus,
  ): Promise<RetrievalChannelOutcome<RetrievedSource>> {
    const q = query.trim();
    if (!q) return { kind: "disabled", results: [] };

    try {
      const standing = await this.auth.resolveStanding(user);
      const ids = standing.accessibleSpaceIds;

      const [ownerFilter, restriction] = await Promise.all([
        this.articleOwnerFilterFor(user),
        this.auth.articleRestrictionPredicate(user),
      ]);

      const pool = Math.max(limit * 3, limit);

      let vectorLiteral: string | null = null;
      if (
        this.aiGateway.isEmbeddingConfigured() &&
        (await this.candidates.hasEmbeddedChunks(user.orgId))
      ) {
        vectorLiteral = await this.vectorFor(q, user.orgId, embedding);
      }

      const pageVisibility = buildVisiblePageScope(standing, "view").predicate;

      const [articleKeyword, articleVector, pageKeyword, pageVector] =
        await Promise.all([
          this.candidates.articleKeywordCandidates(
            user.orgId,
            ids,
            q,
            pool,
            restriction,
            ownerFilter,
            spaceId,
          ),
          vectorLiteral
            ? this.candidates.articleVectorCandidates(
                user.orgId,
                ids,
                vectorLiteral,
                pool,
                restriction,
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
            pageIds,
            spaceId,
            ownerMembershipId,
            status,
          ),
          vectorLiteral
            ? this.candidates.pageVectorCandidates(
                user.orgId,
                vectorLiteral,
                pool,
                chunkVisibleTo(standing),
                verifiedOnly,
                pageIds,
                spaceId,
                ownerMembershipId,
                status,
              )
            : Promise.resolve<number[]>([]),
        ]);

      const lists: string[][] = [];
      if (articleKeyword.length > 0)
        lists.push(articleKeyword.map((id) => `a:${id}`));
      if (articleVector.length > 0)
        lists.push(articleVector.map((id) => `a:${id}`));
      if (pageKeyword.length > 0)
        lists.push(pageKeyword.map((id) => `p:${id}`));
      if (pageVector.length > 0) lists.push(pageVector.map((id) => `p:${id}`));

      const fused = this.candidates.fuseKeys(lists).slice(0, limit);
      if (fused.length === 0) return { kind: "empty", results: [] };

      const articleIds = fused
        .filter((k) => k.startsWith("a:"))
        .map((k) => parseInt(k.slice(2), 10));
      const fusedPageIds = fused
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
        const articleRestriction =
          await this.auth.articleRestrictionPredicate(user);
        if (articleRestriction) articleConditions.push(articleRestriction);
        const articleRows = await this.db
          .select({
            id: kbPages.id,
            title: kbPages.title,
            slug: kbPages.slug,
            spaceId: kbPages.spaceId,
            contentText: kbPages.contentText,
            updatedAt: kbPages.updatedAt,
            aclRevision: kbPages.aclRevision,
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

      if (fusedPageIds.length > 0) {
        const pageConditions: SQL[] = [
          eq(kbPages.orgId, user.orgId),
          inArray(kbPages.id, fusedPageIds),
          wikiPagePredicate(),
          ne(kbPages.status, "archived"),
          pageVisibility,
        ];
        if (spaceId) pageConditions.push(eq(kbPages.spaceId, spaceId));
        const pageRows = await this.db
          .select({
            id: kbPages.id,
            title: kbPages.title,
            spaceId: kbPages.spaceId,
            contentText: kbPages.contentText,
            updatedAt: kbPages.updatedAt,
            aclRevision: kbPages.aclRevision,
          })
          .from(kbPages)
          .where(and(...pageConditions));
        for (const row of pageRows) {
          results.push({
            kind: "page",
            ...row,
            contentText: row.contentText ?? "",
          });
        }
      }

      const order = new Map(fused.map((key, index) => [key, index]));
      const sorted = results.sort((a, b) => {
        const ka = a.kind === "article" ? `a:${a.id}` : `p:${a.id}`;
        const kb = b.kind === "article" ? `a:${b.id}` : `p:${b.id}`;
        return (order.get(ka) ?? 0) - (order.get(kb) ?? 0);
      });

      if (sorted.length === 0) return { kind: "empty", results: [] };
      if (vectorLiteral === null) return { kind: "degraded", results: sorted };
      return { kind: "ok", results: sorted };
    } catch (err) {
      this.logger.warn("KB top-article retrieval failed", {
        orgId: user.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: "failed", results: [] };
    }
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
    const { results } = await this.retrieveDocumentPassagesWithOutcome(
      user,
      query,
      articleIds,
      pageIds,
      embedding,
    );
    return results;
  }

  async retrieveDocumentPassagesWithOutcome(
    user: CurrentUserContext,
    query: string,
    articleIds: number[],
    pageIds: number[] = [],
    embedding?: QueryEmbedding,
  ): Promise<RetrievalChannelOutcome<DegradableContextPassage>> {
    if (articleIds.length === 0 && pageIds.length === 0) {
      return { kind: "disabled", results: [] };
    }
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
      const degradedFlag = vector === null ? { degraded: true as const } : {};
      const askedAsArticle = new Set(articleIds);
      const results = rows.flatMap<DegradableContextPassage>((row) => {
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
            ...degradedFlag,
          },
        ];
      });
      if (vector === null) return { kind: "degraded", results };
      if (results.length === 0) return { kind: "empty", results: [] };
      return { kind: "ok", results };
    } catch (err) {
      this.logger.warn("KB document passage retrieval failed", {
        orgId: user.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: "failed", results: [] };
    }
  }

  async retrieveTopSources(
    user: CurrentUserContext,
    query: string,
    limit: number,
    sourceIds?: number[],
    embedding?: QueryEmbedding,
    spaceId?: number,
  ): Promise<RetrievedSourceDocument[]> {
    const { results } = await this.retrieveTopSourcesWithOutcome(
      user,
      query,
      limit,
      sourceIds,
      embedding,
      spaceId,
    );
    return results;
  }

  async retrieveTopSourcesWithOutcome(
    user: CurrentUserContext,
    query: string,
    limit: number,
    sourceIds?: number[],
    embedding?: QueryEmbedding,
    spaceId?: number,
  ): Promise<RetrievalChannelOutcome<RetrievedSourceDocument>> {
    const q = query.trim();
    if (!q) return { kind: "disabled", results: [] };
    if (!(await this.candidates.hasEmbeddedChunks(user.orgId))) {
      return { kind: "disabled", results: [] };
    }
    try {
      const accessibleSpaceIds = (await this.auth.resolveStanding(user))
        .accessibleSpaceIds;
      const vector = await this.vectorFor(q, user.orgId, embedding);

      const cap = Math.min(limit * 4, PAGE_SIZE_CAP);
      const chunkIds =
        vector === null
          ? []
          : await this.candidates.vectorChunkIds(user.orgId, vector, cap);
      if (vector !== null && chunkIds.length === 0) {
        return { kind: "empty", results: [] };
      }

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
      if (spaceId) {
        const spaceOrGlobal = or(
          isNull(kbSources.spaceId),
          eq(kbSources.spaceId, spaceId),
        );
        if (spaceOrGlobal) conditions.push(spaceOrGlobal);
      }
      if (sourceIds && sourceIds.length > 0)
        conditions.push(inArray(kbSources.id, sourceIds));
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

      const degradedFlag = vector === null ? { degraded: true as const } : {};
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
          ...degradedFlag,
        };
        document.passages.push({
          documentKey: kbDocumentKey("source", row.sourceId),
          documentTitle: row.title,
          passageIndex: row.chunkIndex,
          text: row.content,
        });
        if (existing === undefined) byId.set(row.sourceId, document);
      }
      const results = [...byId.values()];
      if (vector === null) return { kind: "degraded", results };
      if (results.length === 0) return { kind: "empty", results: [] };
      return { kind: "ok", results };
    } catch (err) {
      this.logger.warn("KB top-source retrieval failed", {
        orgId: user.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: "failed", results: [] };
    }
  }
}
