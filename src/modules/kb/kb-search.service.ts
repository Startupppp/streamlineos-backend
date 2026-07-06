import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleChunks, kbPages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { KbAccessService } from "./kb-access.service";
import { KbEventsService } from "./kb-events.service";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { SearchInput } from "./dto/kb-ai.schemas";

const SNIPPET_LENGTH = 160;
const RRF_CONSTANT = 60;

export type RetrievedSource =
  | { kind: "article"; id: number; title: string; slug: string; spaceId: number | null; contentText: string }
  | { kind: "page"; id: number; title: string; spaceId: number | null; contentText: string };

export type { RetrievedSource as RetrievedArticle };

@Injectable()
export class KbSearchService {
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

    const tsquery = sql`websearch_to_tsquery('english', ${input.q})`;
    const conditions: SQL[] = [
      eq(kbArticles.orgId, user.orgId),
      inArray(kbArticles.spaceId, ids),
      ne(kbArticles.status, "archived"),
      this.keywordMatch(input.q, tsquery),
    ];
    if (input.spaceId) conditions.push(eq(kbArticles.spaceId, input.spaceId));
    const where = and(...conditions);

    const [totalRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbArticles)
      .where(where);
    const total = totalRow?.count ?? 0;

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
      .orderBy(desc(this.keywordRank(tsquery)), desc(kbArticles.updatedAt))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize);

    const items = rows.map(({ contentText, ...card }) => ({
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

    const pool = Math.max(limit * 3, limit);
    const lists: string[][] = [];

    if (ids.length > 0) {
      const articleKeyword = await this.articleKeywordCandidates(user.orgId, ids, q, pool, spaceId);
      if (articleKeyword.length > 0) lists.push(articleKeyword.map((id) => `a:${id}`));

      if (this.embeddings.isConfigured()) {
        const articleVector = await this.articleVectorCandidates(user.orgId, ids, q, pool, spaceId);
        if (articleVector.length > 0) lists.push(articleVector.map((id) => `a:${id}`));
      }
    }

    const pageKeyword = await this.pageKeywordCandidates(user.orgId, q, pool);
    if (pageKeyword.length > 0) lists.push(pageKeyword.map((id) => `p:${id}`));

    if (this.embeddings.isConfigured()) {
      const pageVector = await this.pageVectorCandidates(user.orgId, q, pool);
      if (pageVector.length > 0) lists.push(pageVector.map((id) => `p:${id}`));
    }

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
      const articleRows = await this.db
        .select({
          id: kbArticles.id,
          title: kbArticles.title,
          slug: kbArticles.slug,
          spaceId: kbArticles.spaceId,
          contentText: kbArticles.contentText,
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
        })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, user.orgId),
            inArray(kbPages.id, pageIds),
            eq(kbPages.status, "published"),
            isNull(kbPages.deletedAt),
            sql`${kbPages.visibility} IN ('org', 'public')`,
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
    spaceId?: number,
  ): Promise<number[]> {
    const tsquery = sql`websearch_to_tsquery('english', ${query})`;
    const conditions: SQL[] = [
      eq(kbArticles.orgId, orgId),
      inArray(kbArticles.spaceId, spaceIds),
      eq(kbArticles.status, "published"),
      this.keywordMatch(query, tsquery),
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

  private async articleVectorCandidates(
    orgId: string,
    spaceIds: number[],
    query: string,
    pool: number,
    spaceId?: number,
  ): Promise<number[]> {
    try {
      const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));
      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
      const conditions: SQL[] = [
        eq(kbArticleChunks.orgId, orgId),
        isNotNull(kbArticleChunks.articleId),
        inArray(kbArticles.spaceId, spaceIds),
        eq(kbArticles.status, "published"),
      ];
      if (spaceId) conditions.push(eq(kbArticles.spaceId, spaceId));

      const rows = await this.db
        .select({ articleId: kbArticleChunks.articleId })
        .from(kbArticleChunks)
        .innerJoin(kbArticles, eq(kbArticles.id, kbArticleChunks.articleId))
        .where(and(...conditions))
        .orderBy(distance)
        .limit(pool * 4);

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
    } catch {
      return [];
    }
  }

  private async pageKeywordCandidates(
    orgId: string,
    query: string,
    pool: number,
  ): Promise<number[]> {
    const tsquery = sql`websearch_to_tsquery('english', ${query})`;
    const term = `%${query}%`;
    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          eq(kbPages.status, "published"),
          isNull(kbPages.deletedAt),
          sql`${kbPages.visibility} IN ('org', 'public')`,
          sql`(fts @@ ${tsquery} OR (numnode(${tsquery}) = 0 AND ${kbPages.title} ILIKE ${term}))`,
        ),
      )
      .orderBy(desc(sql`ts_rank(fts, ${tsquery})`), desc(kbPages.updatedAt))
      .limit(pool);
    return rows.map((row) => row.id);
  }

  private async pageVectorCandidates(
    orgId: string,
    query: string,
    pool: number,
  ): Promise<number[]> {
    try {
      const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));
      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
      const rows = await this.db
        .select({ pageId: kbArticleChunks.pageId })
        .from(kbArticleChunks)
        .innerJoin(
          kbPages,
          and(
            eq(kbPages.id, kbArticleChunks.pageId),
            eq(kbPages.status, "published"),
            isNull(kbPages.deletedAt),
            sql`${kbPages.visibility} IN ('org', 'public')`,
          ),
        )
        .where(
          and(
            eq(kbArticleChunks.orgId, orgId),
            isNotNull(kbArticleChunks.pageId),
            eq(kbPages.orgId, orgId),
          ),
        )
        .orderBy(distance)
        .limit(pool * 4);

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
    } catch {
      return [];
    }
  }

  private keywordMatch(query: string, tsquery: SQL): SQL {
    const term = `%${query}%`;
    return sql`(fts @@ ${tsquery} or (numnode(${tsquery}) = 0 and (${kbArticles.title} ilike ${term} or ${kbArticles.excerpt} ilike ${term} or ${kbArticles.contentText} ilike ${term})))`;
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
    orgId: string,
    query: string,
    articleIds: number[],
  ): Promise<string> {
    if (!this.embeddings.isConfigured() || articleIds.length === 0) return "";
    try {
      const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));
      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
      const rows = await this.db
        .select({ content: kbArticleChunks.content })
        .from(kbArticleChunks)
        .where(
          and(
            eq(kbArticleChunks.orgId, orgId),
            eq(kbArticleChunks.source, "attachment"),
            inArray(kbArticleChunks.articleId, articleIds),
          ),
        )
        .orderBy(distance)
        .limit(4);
      return rows
        .map((row, index) => `[file ${index + 1}]\n${row.content.slice(0, 1200)}`)
        .join("\n\n");
    } catch {
      return "";
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
