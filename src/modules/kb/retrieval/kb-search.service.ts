import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleChunks, kbPages, kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { KbEventsService } from "../core/kb-events.service";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { pageVisibleTo } from "./kb-page-visibility";
import { EmbeddingsService } from "../../ai/core/providers/embeddings.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { SearchInput } from "./dto/kb-ai.schemas";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { KbCandidateService } from "./kb-candidate.service";

export type RetrievedSource =
  | { kind: "article"; id: number; title: string; slug: string; spaceId: number | null; contentText: string; updatedAt: Date }
  | { kind: "page"; id: number; title: string; spaceId: number | null; contentText: string; updatedAt: Date };

@Injectable()
export class KbSearchService {
  private readonly logger = new Logger(KbSearchService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly embeddings: EmbeddingsService,
    private readonly events: KbEventsService,
    private readonly candidates: KbCandidateService,
  ) {}

  async search(
    user: CurrentUserContext,
    input: SearchInput,
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
    if (input.spaceId) conditions.push(eq(kbArticles.spaceId, input.spaceId));
    const where = and(...conditions);

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
        totalCount: sql<string>`count(*) OVER ()`,
      })
      .from(kbArticles)
      .where(where)
      .orderBy(desc(this.candidates.keywordRank(tsquery)), desc(kbArticles.updatedAt))
      .limit(input.pageSize)
      .offset(offset);

    const first = rows[0];
    let total: number;
    if (first) {
      total = Number(first.totalCount);
    } else if (offset === 0) {
      total = 0;
    } else {
      const [countRow] = await this.db.select({ count: sql<number>`count(*)::int` }).from(kbArticles).where(where);
      total = countRow?.count ?? 0;
    }

    const items = rows.map(({ totalCount: _, contentText, ...card }) => ({
      ...card,
      snippet: this.candidates.buildSnippet(contentText, input.q),
    }));

    await this.events.record(user.orgId, total > 0 ? "search" : "search_no_results", {
      actorId: user.userId,
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

    const pool = Math.max(limit * 3, limit);
    const hasSpaces = ids.length > 0;

    let vectorLiteral: string | null = null;
    if (this.embeddings.isConfigured() && (await this.candidates.hasEmbeddedChunks(user.orgId))) {
      try {
        vectorLiteral = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(q));
      } catch (err: unknown) {
        vectorLiteral = null;
        logSideEffectFailure("kb semantic search embedding", { orgId: user.orgId })(err);
      }
    }

    const projectIds = await this.access.getAccessibleProjectIds(user);
    const pageVisibility = pageVisibleTo(user, projectIds);

    const [articleKeyword, articleVector, pageKeyword, pageVector] = await Promise.all([
      hasSpaces
        ? this.candidates.articleKeywordCandidates(user.orgId, ids, q, pool, principal, spaceId)
        : Promise.resolve<number[]>([]),
      hasSpaces && vectorLiteral
        ? this.candidates.articleVectorCandidates(user.orgId, ids, vectorLiteral, pool, principal, spaceId)
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
    if (!this.embeddings.isConfigured() || (articleIds.length === 0 && pageIds.length === 0)) {
      return "";
    }
    try {
      const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));
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
    if (!this.embeddings.isConfigured() || !query.trim()) return [];
    if (!(await this.candidates.hasEmbeddedChunks(user.orgId))) return [];
    try {
      const accessibleSpaceIds = await this.access.getAccessibleSpaceIds(user);
      const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));

      const cap = limit * 4;
      const chunkIds = await this.candidates.vectorChunkIds(vector, cap);
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
