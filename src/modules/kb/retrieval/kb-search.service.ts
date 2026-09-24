import { Inject, Injectable, Logger } from "@nestjs/common";
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
import {
  kbArticles,
  kbArticleChunks,
  kbPages,
  kbSources,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { KbEventsService } from "../core/kb-events.service";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { SearchInput } from "./dto/kb-ai.schemas";
import type { ScopedRead } from "../../access/scoped-read";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { KbCandidateService } from "./kb-candidate.service";
import { AccessService } from "../../access/access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
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
  ) {}

  async articleOwnerFilterFor(user: CurrentUserContext): Promise<SQL> {
    const read = await resolveKbArticlesViewScope(this.scopes, user);
    return articleOwnerScopeFilter(read, user);
  }

  async articleRestrictionFilterFor(
    user: CurrentUserContext,
  ): Promise<SQL | null> {
    if (await this.access.isAdmin(user)) return null;
    const principal = await this.access.getPrincipalIds(user);
    return this.candidates.articleRestrictionFilter(user.orgId, principal);
  }

  private async embedOrDegrade(
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
    if (scope.denied)
      return {
        items: [],
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
        totalPages: 0,
      };

    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0) {
      return {
        items: [],
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
        totalPages: 0,
      };
    }

    const isAdmin = await this.access.isAdmin(user);
    const principal = await this.access.getPrincipalIds(user);

    const tsquery = sql`websearch_to_tsquery('english', ${input.q})`;
    const keywordCond = await this.candidates.resolveArticleKeywordCondition(
      input.q,
      tsquery,
      500,
    );
    const domain: SQL[] = [
      inArray(kbArticles.spaceId, ids),
      ne(kbArticles.status, "archived"),
      keywordCond,
    ];
    if (!isAdmin)
      domain.push(
        this.candidates.articleRestrictionFilter(user.orgId, principal),
      );
    if (input.spaceId) domain.push(eq(kbArticles.spaceId, input.spaceId));
    // The same narrowing `GET /kb/articles` applies, in the predicate rather than
    // downstream: these rows carry article text and are what retrieval hands on.
    const membershipId =
      user.principal === undefined ? null : actingMembershipId(user.principal);
    const where = scope.compose(
      {
        tenant: kbArticles.orgId,
        scope: articleOwnerScope(membershipId),
        and: domain,
      },
      ({ sql: composed }) => composed,
      () => sql`false`,
    );

    const offset = (input.page - 1) * input.pageSize;

    const rows = await this.db
      .select({
        id: kbArticles.id,
        spaceId: kbArticles.spaceId,
        categoryId: kbArticles.categoryId,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        status: kbArticles.status,
        updatedAt: kbArticles.updatedAt,
        contentText: kbArticles.contentText,
      })
      .from(kbArticles)
      .where(where)
      .orderBy(
        desc(this.candidates.keywordRank(tsquery)),
        desc(kbArticles.updatedAt),
      )
      .limit(input.pageSize)
      .offset(offset);

    // Sequential, not `Promise.all`: both statements run on the request's single tenant
    // connection, so concurrency here would only queue them behind each other anyway.
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbArticles)
      .where(where);
    const total = countRow?.count ?? 0;

    const items = rows.map(({ contentText, ...card }) => ({
      ...card,
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
  ): Promise<RetrievedSource[]> {
    const ids = await this.access.getAccessibleSpaceIds(user);
    const q = query.trim();
    if (!q) return [];

    const isAdmin = await this.access.isAdmin(user);
    const principal = await this.access.getPrincipalIds(user);
    const ownerFilter = await this.articleOwnerFilterFor(user);

    const pool = Math.max(limit * 3, limit);
    const hasSpaces = ids.length > 0;

    let vectorLiteral: string | null = null;
    if (
      this.aiGateway.isEmbeddingConfigured() &&
      (await this.candidates.hasEmbeddedChunks(user.orgId))
    ) {
      vectorLiteral = await this.embedOrDegrade(q, user.orgId);
    }

    const projectIds = await this.access.getAccessibleProjectIds(user);
    const pageVisibility = await this.auth.visiblePagePredicate(user, "view");

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
        ),
        vectorLiteral
          ? this.candidates.pageVectorCandidates(
              user.orgId,
              vectorLiteral,
              pool,
              chunkVisibleTo(user, projectIds),
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
        eq(kbArticles.orgId, user.orgId),
        inArray(kbArticles.id, articleIds),
        eq(kbArticles.status, "published"),
      ];
      if (spaceId) articleConditions.push(eq(kbArticles.spaceId, spaceId));
      if (ownerFilter) articleConditions.push(ownerFilter);
      if (!isAdmin)
        articleConditions.push(
          this.candidates.articleRestrictionFilter(user.orgId, principal),
        );
      const articleRows = await this.db
        .select({
          id: kbArticles.id,
          title: kbArticles.title,
          slug: kbArticles.slug,
          spaceId: kbArticles.spaceId,
          contentText: kbArticles.contentText,
          updatedAt: kbArticles.updatedAt,
        })
        .from(kbArticles)
        .where(and(...articleConditions));
      for (const row of articleRows) {
        results.push({
          kind: "article",
          ...row,
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
            isNull(kbPages.deletedAt),
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

  /**
   * The article half of the attachment predicate. It used to be `inArray(articleId, ids)`
   * alone, so the method's safety was a precondition on its one caller rather than a
   * property of the method — the page half already carried `pageVisibleTo`.
   */
  private async attachmentArticleScope(
    user: CurrentUserContext,
    articleIds: number[],
  ): Promise<SQL[]> {
    const [ownerFilter, restrictionFilter] = await Promise.all([
      this.articleOwnerFilterFor(user),
      this.articleRestrictionFilterFor(user),
    ]);
    // The owner filter is a scoped read, so it already carries `kb_articles.org_id`.
    const conditions: SQL[] = [
      inArray(kbArticleChunks.articleId, articleIds),
      eq(kbArticles.status, "published"),
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
  ): Promise<DegradableContextPassage[]> {
    if (articleIds.length === 0 && pageIds.length === 0) return [];
    try {
      const vector = this.aiGateway.isEmbeddingConfigured()
        ? await this.embedOrDegrade(query, user.orgId)
        : null;
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
          ...(await this.attachmentArticleScope(user, articleIds)),
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
          pagePredicate,
        );
        if (pageScope) scope.push(pageScope);
      }
      const rows = await this.db
        .select({
          content: kbArticleChunks.content,
          chunkIndex: kbArticleChunks.chunkIndex,
          articleId: kbArticleChunks.articleId,
          pageId: kbArticleChunks.pageId,
          articleTitle: kbArticles.title,
          pageTitle: kbPages.title,
        })
        .from(kbArticleChunks)
        .leftJoin(
          kbPages,
          and(
            eq(kbPages.id, kbArticleChunks.pageId),
            eq(kbPages.orgId, kbArticleChunks.orgId),
          ),
        )
        .leftJoin(
          kbArticles,
          and(
            eq(kbArticles.id, kbArticleChunks.articleId),
            eq(kbArticles.orgId, kbArticleChunks.orgId),
          ),
        )
        .where(and(eq(kbArticleChunks.orgId, user.orgId), or(...scope)))
        .orderBy(...ordering)
        .limit(Math.min(KB_DOCUMENT_PASSAGE_ROWS, PAGE_SIZE_CAP));
      const degraded = vector === null ? { degraded: true as const } : {};
      return rows.flatMap<DegradableContextPassage>((row) => {
        if (row.articleId !== null)
          return [
            {
              documentKey: kbDocumentKey("article", row.articleId),
              documentTitle: row.articleTitle ?? "",
              passageIndex: row.chunkIndex,
              text: row.content,
              ...degraded,
            },
          ];
        if (row.pageId !== null)
          return [
            {
              documentKey: kbDocumentKey("page", row.pageId),
              documentTitle: row.pageTitle ?? "",
              passageIndex: row.chunkIndex,
              text: row.content,
              ...degraded,
            },
          ];
        return [];
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
  ): Promise<RetrievedSourceDocument[]> {
    const q = query.trim();
    if (!q) return [];
    if (!(await this.candidates.hasEmbeddedChunks(user.orgId))) return [];
    try {
      const accessibleSpaceIds = await this.access.getAccessibleSpaceIds(user);
      const vector = this.aiGateway.isEmbeddingConfigured()
        ? await this.embedOrDegrade(q, user.orgId)
        : null;

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
