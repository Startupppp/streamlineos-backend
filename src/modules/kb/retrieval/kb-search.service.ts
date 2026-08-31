import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleChunks, kbArticleRestrictions, kbPages, kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { KbEventsService } from "../core/kb-events.service";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { pageVisibleTo, visibleTo } from "./kb-page-visibility";
import { EmbeddingsService } from "../../ai/core/providers/embeddings.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { SearchInput } from "./dto/kb-ai.schemas";
import { logSideEffectFailure } from "../../../common/logger/side-effect";

const SNIPPET_LENGTH = 160;
const RRF_CONSTANT = 60;

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
    const keywordCond = await this.resolveArticleKeywordCondition(input.q, tsquery, 500);
    const conditions: SQL[] = [
      eq(kbArticles.orgId, user.orgId),
      inArray(kbArticles.spaceId, ids),
      ne(kbArticles.status, "archived"),
      keywordCond,
    ];
    if (!isAdmin) conditions.push(this.articleRestrictionFilter(user.orgId, principal));
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
      .orderBy(desc(this.keywordRank(tsquery)), desc(kbArticles.updatedAt))
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
      snippet: this.buildSnippet(contentText, input.q),
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
    if (this.embeddings.isConfigured() && (await this.hasEmbeddedChunks(user.orgId))) {
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
        ? this.articleKeywordCandidates(user.orgId, ids, q, pool, principal, spaceId)
        : Promise.resolve<number[]>([]),
      hasSpaces && vectorLiteral
        ? this.articleVectorCandidates(user.orgId, ids, vectorLiteral, pool, principal, spaceId)
        : Promise.resolve<number[]>([]),
      this.pageKeywordCandidates(user.orgId, q, pool, pageVisibility),
      vectorLiteral
        ? this.pageVectorCandidates(
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

    const fused = this.fuseKeys(lists).slice(0, limit);
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
      if (!isAdmin) articleConditions.push(this.articleRestrictionFilter(user.orgId, principal));
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

  private async articleKeywordCandidates(
    orgId: string,
    spaceIds: number[],
    query: string,
    pool: number,
    principal: { userId: string; roleSlugs: string[] },
    spaceId?: number,
  ): Promise<number[]> {
    const tsquery = sql`websearch_to_tsquery('english', ${query})`;
    const keywordCond = await this.resolveArticleKeywordCondition(query, tsquery, 500);
    const conditions: SQL[] = [
      eq(kbArticles.orgId, orgId),
      inArray(kbArticles.spaceId, spaceIds),
      eq(kbArticles.status, "published"),
      keywordCond,
      this.articleRestrictionFilter(orgId, principal),
    ];
    if (spaceId) conditions.push(eq(kbArticles.spaceId, spaceId));

    const rows = await this.db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .where(and(...conditions))
      .orderBy(desc(this.keywordRank(tsquery)), desc(kbArticles.updatedAt))
      .limit(pool);
    return rows.map((row) => row.id);
  }

  private async hasEmbeddedChunks(orgId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: kbArticleChunks.id })
      .from(kbArticleChunks)
      .where(and(eq(kbArticleChunks.orgId, orgId), isNotNull(kbArticleChunks.embedding)))
      .limit(1);
    return row !== undefined;
  }

  private async vectorChunkIds(vector: string, cap: number): Promise<number[]> {
    const rows = await this.db.execute(sql`SELECT app.search_kb_chunk_ids(${vector}::vector, ${cap}) AS id`);
    return rows.map(r => Number(r["id"]));
  }

  private async articleVectorCandidates(
    orgId: string,
    spaceIds: number[],
    vector: string,
    pool: number,
    principal: { userId: string; roleSlugs: string[] },
    spaceId?: number,
  ): Promise<number[]> {
    try {
      const cap = pool * 4;
      const chunkIds = await this.vectorChunkIds(vector, cap);
      if (chunkIds.length === 0) return [];

      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
      const conditions: SQL[] = [
        inArray(kbArticleChunks.id, chunkIds),
        isNotNull(kbArticleChunks.articleId),
        inArray(kbArticles.spaceId, spaceIds),
        eq(kbArticles.status, "published"),
        this.articleRestrictionFilter(orgId, principal),
      ];
      if (spaceId) conditions.push(eq(kbArticles.spaceId, spaceId));

      const rows = await this.db
        .select({ articleId: kbArticleChunks.articleId })
        .from(kbArticleChunks)
        .innerJoin(kbArticles, and(
          eq(kbArticles.id, kbArticleChunks.articleId),
          eq(kbArticleChunks.aclRevision, kbArticles.aclRevision),
        ))
        .where(and(...conditions))
        .orderBy(distance)
        .limit(cap);

      const seen = new Set<number>();
      const result: number[] = [];
      for (const row of rows) {
        const id = row.articleId;
        if (id === null || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
        if (result.length >= pool) break;
      }
      return result;
    } catch (err) {
      this.logger.warn("KB article vector candidate retrieval failed", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async pageKeywordCandidates(
    orgId: string,
    query: string,
    pool: number,
    pageVisibility: SQL,
  ): Promise<number[]> {
    const tsquery = sql`websearch_to_tsquery('english', ${query})`;
    const keywordCond = await this.resolvePageKeywordCondition(query, pool, tsquery);
    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          pageVisibility,
          keywordCond,
        ),
      )
      .orderBy(desc(sql`ts_rank(fts, ${tsquery})`), desc(kbPages.updatedAt))
      .limit(pool);
    return rows.map((row) => row.id);
  }

  private async resolvePageKeywordCondition(q: string, cap: number, tsquery: SQL): Promise<SQL> {
    const term = `%${q}%`;
    const fallback = sql`(fts @@ ${tsquery} OR (numnode(${tsquery}) = 0 AND ${kbPages.title} ILIKE ${term}))`;
    const rows = await this.db.execute(sql`SELECT app.search_kb_page_ids(${q}, ${cap + 1}) AS id`);
    if (rows.length === 0 || rows.length > cap) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(kbPages.id, ids);
  }

  private async pageVectorCandidates(
    orgId: string,
    vector: string,
    pool: number,
    chunkVisibility: SQL,
  ): Promise<number[]> {
    try {
      const cap = pool * 4;
      const chunkIds = await this.vectorChunkIds(vector, cap);
      if (chunkIds.length === 0) return [];

      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
      const rows = await this.db
        .select({ pageId: kbArticleChunks.pageId })
        .from(kbArticleChunks)
        .innerJoin(kbPages, and(
          eq(kbPages.id, kbArticleChunks.pageId),
          eq(kbArticleChunks.aclRevision, kbPages.aclRevision),
        ))
        .where(
          and(
            inArray(kbArticleChunks.id, chunkIds),
            isNotNull(kbArticleChunks.pageId),
            chunkVisibility,
          ),
        )
        .orderBy(distance)
        .limit(cap);

      const seen = new Set<number>();
      const result: number[] = [];
      for (const row of rows) {
        const id = row.pageId;
        if (id === null || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
        if (result.length >= pool) break;
      }
      return result;
    } catch (err) {
      this.logger.warn("KB page vector candidate retrieval failed", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private articleRestrictionFilter(
    orgId: string,
    principal: { userId: string; roleSlugs: string[] },
  ): SQL {
    const kar = kbArticleRestrictions;
    return sql`(
      NOT EXISTS (
        SELECT 1 FROM ${kar}
        WHERE ${kar.articleId} = ${kbArticles.id}
          AND ${kar.orgId} = ${orgId}
          AND ${kar.level} = 'view'
      )
      OR EXISTS (
        SELECT 1 FROM ${kar}
        WHERE ${kar.articleId} = ${kbArticles.id}
          AND ${kar.orgId} = ${orgId}
          AND ${kar.level} = 'view'
          AND (${kar.userId} = ${principal.userId} OR ${
            principal.roleSlugs.length > 0
              ? sql`${kar.role} = ANY(${principal.roleSlugs})`
              : sql`false`
          })
      )
    )`;
  }

  private async resolveArticleKeywordCondition(q: string, tsquery: SQL, cap: number): Promise<SQL> {
    const term = `%${q}%`;
    const fallback = sql`(fts @@ ${tsquery} or (numnode(${tsquery}) = 0 and (${kbArticles.title} ilike ${term} or ${kbArticles.excerpt} ilike ${term} or ${kbArticles.contentText} ilike ${term})))`;
    const rows = await this.db.execute(sql`SELECT app.search_kb_article_ids(${q}, ${cap + 1}) AS id`);
    if (rows.length === 0 || rows.length > cap) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(kbArticles.id, ids);
  }

  private keywordRank(tsquery: SQL): SQL<number> {
    return sql<number>`ts_rank(fts, ${tsquery})`;
  }

  private fuseKeys(lists: string[][]): string[] {
    const scores = new Map<string, number>();
    for (const list of lists) {
      list.forEach((key, rank) => {
        scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_CONSTANT + rank + 1));
      });
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
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
    if (!(await this.hasEmbeddedChunks(user.orgId))) return [];
    try {
      const accessibleSpaceIds = await this.access.getAccessibleSpaceIds(user);
      const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));

      const cap = limit * 4;
      const chunkIds = await this.vectorChunkIds(vector, cap);
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

  private buildSnippet(contentText: string | null, query: string): string {
    const text = (contentText ?? "").trim();
    if (!text) return "";
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    const start = index > 0 ? index : 0;
    return text.slice(start, start + SNIPPET_LENGTH).trim();
  }
}
