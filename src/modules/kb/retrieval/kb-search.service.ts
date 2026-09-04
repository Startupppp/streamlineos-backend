import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleChunks, kbPages, kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { KbEventsService } from "../core/kb-events.service";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { pageVisibleTo } from "./kb-page-visibility";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { SearchInput } from "./dto/kb-ai.schemas";
import type { DataScope } from "../../access/access.types";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { actingMembershipId } from "../../../common/auth/principal";
import { KbCandidateService } from "./kb-candidate.service";
import { AccessService } from "../../access/access.service";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
import { articleOwnerScopeFilter } from "./kb-article-owner-scope";

const KB_SEARCH_FEATURE = "kb.search";

export type RetrievedSource =
  | { kind: "article"; id: number; title: string; slug: string; spaceId: number | null; contentText: string; updatedAt: Date }
  | { kind: "page"; id: number; title: string; spaceId: number | null; contentText: string; updatedAt: Date };

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
  ) {}

  /**
   * Retrieval resolves the asker's own `kb:articles:view` DataScope rather than
   * accepting one, so no RAG caller — `POST /kb/ask`, the research brief graph or
   * any future one — can reach the vector index without the predicate the direct
   * read endpoint applies.
   */
  async articleOwnerFilterFor(user: CurrentUserContext): Promise<SQL | null> {
    const articleScope = await resolveKbArticlesViewScope(this.scopes, user);
    return articleOwnerScopeFilter(articleScope, user);
  }

  /**
   * The second of the two article ACL dimensions, as a façade in the same shape as
   * `articleOwnerFilterFor` above and for the same reason.
   *
   * Article visibility is owner scope AND per-article `kb_article_restrictions`.
   * Retrieval applies both on the way in (`search`, `retrieveTopArticles`,
   * `KbCandidateService.article{Keyword,Vector}Candidates`), but the post-answer
   * citation re-verification in `KbAskService.resolveVisibleArticles` only ever
   * re-applied the owner half — so a restriction added between retrieval and the
   * model's reply was invisible to the check whose entire job is to catch exactly
   * that window. Both halves resolve through one call now, so the two paths cannot
   * drift apart again by one caller forgetting a condition.
   *
   * Returns `null` for a `kb:spaces:manage` holder, matching `search`'s
   * `if (!isAdmin)`: an admin is not subject to per-article restrictions, and
   * pushing the predicate anyway would strip their own citations.
   */
  async articleRestrictionFilterFor(user: CurrentUserContext): Promise<SQL | null> {
    if (await this.access.isAdmin(user)) return null;
    const principal = await this.access.getPrincipalIds(user);
    return this.candidates.articleRestrictionFilter(user.orgId, principal);
  }

  private async embedSearchQuery(text: string, orgId: string) {
    return this.aiGateway.embedQueryWithCredit({
      text,
      orgId,
      feature: KB_SEARCH_FEATURE,
      charge: true,
    });
  }

  async search(
    user: CurrentUserContext,
    input: SearchInput,
    scope: DataScope,
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
    if (scope === "none")
      return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 0 };

    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0) {
      return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 0 };
    }

    const isAdmin = await this.access.isAdmin(user);
    const principal = await this.access.getPrincipalIds(user);

    const tsquery = sql`websearch_to_tsquery('english', ${input.q})`;
    const keywordCond = await this.candidates.resolveArticleKeywordCondition(input.q, tsquery, 500);
    const conditions: SQL[] = [
      eq(kbArticles.orgId, user.orgId),
      inArray(kbArticles.spaceId, ids),
      ne(kbArticles.status, "archived"),
      keywordCond,
    ];
    if (!isAdmin) conditions.push(this.candidates.articleRestrictionFilter(user.orgId, principal));
    // The same narrowing `GET /kb/articles` applies, in the predicate rather than
    // downstream: these rows carry article text and are what retrieval hands on.
    const ownerFilter = articleOwnerScopeFilter(scope, user);
    if (ownerFilter) conditions.push(ownerFilter);
    if (input.spaceId) conditions.push(eq(kbArticles.spaceId, input.spaceId));
    const where = and(...conditions);

    const offset = (input.page - 1) * input.pageSize;

    /**
     * Two statements, not one `count(*) OVER ()`, and the reason is measured rather than
     * argued. Backend CLAUDE.md §7 prefers the window function so page and count are one
     * pass, and also says to measure both in buffers before choosing. On a 60,000-match
     * tenant in the scratch database, page 1:
     *
     *   window fn : Limit → Sort → WindowAgg (actual rows=60,000, Storage: Disk 9,415 kB)
     *               2,374 shared hits + 3,084 temp blocks, 35.7 ms, NO parallelism
     *   two passes: page 2,419 shared + count 2,371 shared, 0 temp, 9.8 + 9.7 ms, both
     *               Parallel Seq Scan
     *
     * `count(*) OVER ()` buffers its entire input into a tuplestore before it can emit the
     * first row, so a broad term on a large tenant spills ~9 MB to temp files on EVERY
     * request including page 1 — and the window function also disqualifies the parallel plan.
     * A plain aggregate streams. The trade is 2× shared buffer hits (RAM, already warm) for
     * zero temp I/O, which is the resource that saturates under concurrency.
     *
     * `total` stays exact, so the response contract is unchanged — this is a plan change, not
     * a semantics change.
     */
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
      .orderBy(desc(this.candidates.keywordRank(tsquery)), desc(kbArticles.updatedAt))
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

    await this.events.record(user.orgId, total > 0 ? "search" : "search_no_results", {
      actorMembershipId: actingMembershipId(user.principal) ?? null,
      query: input.q,
      metadata: { resultsCount: total },
    });

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
    if (this.aiGateway.isEmbeddingConfigured() && (await this.candidates.hasEmbeddedChunks(user.orgId))) {
      try {
        const embedResult = await this.embedSearchQuery(q, user.orgId);
        vectorLiteral = embedResult.ok ? embedResult.vectorLiteral : null;
        if (!embedResult.ok)
          this.logger.warn("KB semantic search embedding unavailable — keyword only", {
            orgId: user.orgId,
            kind: embedResult.kind,
          });
      } catch (err: unknown) {
        vectorLiteral = null;
        logSideEffectFailure("kb semantic search embedding", { orgId: user.orgId })(err);
      }
    }

    const projectIds = await this.access.getAccessibleProjectIds(user);
    const pageVisibility = pageVisibleTo(user, projectIds);

    const [articleKeyword, articleVector, pageKeyword, pageVector] = await Promise.all([
      hasSpaces
        ? this.candidates.articleKeywordCandidates(user.orgId, ids, q, pool, principal, ownerFilter, spaceId)
        : Promise.resolve<number[]>([]),
      hasSpaces && vectorLiteral
        ? this.candidates.articleVectorCandidates(user.orgId, ids, vectorLiteral, pool, principal, ownerFilter, spaceId)
        : Promise.resolve<number[]>([]),
      this.candidates.pageKeywordCandidates(user.orgId, q, pool, pageVisibility),
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
    if (articleKeyword.length > 0) lists.push(articleKeyword.map((id) => `a:${id}`));
    if (articleVector.length > 0) lists.push(articleVector.map((id) => `a:${id}`));
    if (pageKeyword.length > 0) lists.push(pageKeyword.map((id) => `p:${id}`));
    if (pageVector.length > 0) lists.push(pageVector.map((id) => `p:${id}`));

    const fused = this.candidates.fuseKeys(lists).slice(0, limit);
    if (fused.length === 0) return [];

    const articleIds = fused.filter((k) => k.startsWith("a:")).map((k) => parseInt(k.slice(2), 10));
    const pageIds = fused.filter((k) => k.startsWith("p:")).map((k) => parseInt(k.slice(2), 10));

    const results: RetrievedSource[] = [];

    if (articleIds.length > 0) {
      const articleConditions: SQL[] = [
        eq(kbArticles.orgId, user.orgId),
        inArray(kbArticles.id, articleIds),
        eq(kbArticles.status, "published"),
      ];
      if (spaceId) articleConditions.push(eq(kbArticles.spaceId, spaceId));
      if (ownerFilter) articleConditions.push(ownerFilter);
      if (!isAdmin) articleConditions.push(this.candidates.articleRestrictionFilter(user.orgId, principal));
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
        results.push({ kind: "article", ...row, contentText: row.contentText ?? "" });
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
        results.push({ kind: "page", ...row, contentText: row.contentText ?? "" });
      }
    }

    const order = new Map(fused.map((key, index) => [key, index]));
    return results.sort((a, b) => {
      const ka = a.kind === "article" ? `a:${a.id}` : `p:${a.id}`;
      const kb = b.kind === "article" ? `a:${b.id}` : `p:${b.id}`;
      return (order.get(ka) ?? 0) - (order.get(kb) ?? 0);
    });
  }

  async retrieveAttachmentSnippets(
    user: CurrentUserContext,
    query: string,
    articleIds: number[],
    pageIds: number[] = [],
  ): Promise<string> {
    if (!this.aiGateway.isEmbeddingConfigured() || (articleIds.length === 0 && pageIds.length === 0)) {
      return "";
    }
    try {
      const embedResult = await this.embedSearchQuery(query, user.orgId);
      if (!embedResult.ok) return "";
      const vector = embedResult.vectorLiteral;
      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
      const scope: SQL[] = [];
      if (articleIds.length > 0)
        scope.push(inArray(kbArticleChunks.articleId, articleIds));
      if (pageIds.length > 0) {
        const projectIds = await this.access.getAccessibleProjectIds(user);
        const pageScope = and(
          inArray(kbArticleChunks.pageId, pageIds),
          pageVisibleTo(user, projectIds),
        );
        if (pageScope) scope.push(pageScope);
      }
      const rows = await this.db
        .select({ content: kbArticleChunks.content })
        .from(kbArticleChunks)
        .leftJoin(kbPages, eq(kbPages.id, kbArticleChunks.pageId))
        .where(
          and(
            eq(kbArticleChunks.orgId, user.orgId),
            eq(kbArticleChunks.source, "attachment"),
            or(...scope),
          ),
        )
        .orderBy(distance)
        .limit(4);
      return rows
        .map((row, index) => `[file ${index + 1}]\n${row.content.slice(0, 1200)}`)
        .join("\n\n");
    } catch (err) {
      this.logger.warn("KB attachment snippet retrieval failed", {
        orgId: user.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }

  async retrieveTopSources(
    user: CurrentUserContext,
    query: string,
    limit: number,
  ): Promise<Array<{ sourceId: number; title: string; spaceId: number | null; snippet: string; updatedAt: Date }>> {
    if (!this.aiGateway.isEmbeddingConfigured() || !query.trim()) return [];
    if (!(await this.candidates.hasEmbeddedChunks(user.orgId))) return [];
    try {
      const accessibleSpaceIds = await this.access.getAccessibleSpaceIds(user);
      const embedResult = await this.embedSearchQuery(query, user.orgId);
      if (!embedResult.ok) return [];
      const vector = embedResult.vectorLiteral;

      const cap = limit * 4;
      const chunkIds = await this.candidates.vectorChunkIds(user.orgId, vector, cap);
      if (chunkIds.length === 0) return [];

      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;

      const spaceFilter = accessibleSpaceIds.length > 0
        ? or(isNull(kbSources.spaceId), inArray(kbSources.spaceId, accessibleSpaceIds))
        : isNull(kbSources.spaceId);

      const rows = await this.db
        .select({
          sourceId: kbSources.id,
          title: kbSources.title,
          spaceId: kbSources.spaceId,
          updatedAt: kbSources.updatedAt,
          content: kbArticleChunks.content,
        })
        .from(kbArticleChunks)
        .innerJoin(kbSources, eq(kbSources.id, kbArticleChunks.sourceId))
        .where(
          and(
            inArray(kbArticleChunks.id, chunkIds),
            eq(kbArticleChunks.orgId, user.orgId),
            eq(kbArticleChunks.source, "source"),
            isNull(kbSources.deletedAt),
            eq(kbSources.status, "ready"),
            eq(kbSources.orgId, user.orgId),
            spaceFilter,
          ),
        )
        .orderBy(distance)
        .limit(cap);

      const seen = new Set<number>();
      const result: Array<{ sourceId: number; title: string; spaceId: number | null; snippet: string; updatedAt: Date }> = [];
      for (const row of rows) {
        const id = row.sourceId;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({ sourceId: id, title: row.title, spaceId: row.spaceId, updatedAt: row.updatedAt, snippet: row.content.slice(0, 1200) });
        if (result.length >= limit) break;
      }
      return result;
    } catch (err) {
      this.logger.warn("KB top-source retrieval failed", {
        orgId: user.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
