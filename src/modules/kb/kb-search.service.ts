import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleChunks } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { KbAccessService } from "./kb-access.service";
import { KbEventsService } from "./kb-events.service";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { SearchInput } from "./dto/kb-ai.schemas";

const SNIPPET_LENGTH = 160;
const RRF_CONSTANT = 60;

export interface RetrievedArticle {
  id: number;
  title: string;
  slug: string;
  spaceId: number | null;
  contentText: string;
}

@Injectable()
export class KbSearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly embeddings: EmbeddingsService,
    private readonly events: KbEventsService,
  ) {}

  async search(user: CurrentUserContext, input: SearchInput) {
    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0) {
      return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 0 };
    }

    const term = `%${input.q}%`;
    const conditions: SQL[] = [eq(kbArticles.orgId, user.orgId), inArray(kbArticles.spaceId, ids)];
    if (input.spaceId) conditions.push(eq(kbArticles.spaceId, input.spaceId));
    const match = or(
      ilike(kbArticles.title, term),
      ilike(kbArticles.excerpt, term),
      ilike(kbArticles.contentText, term),
    );
    if (match) conditions.push(match);
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
      .orderBy(desc(kbArticles.updatedAt))
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
  ): Promise<RetrievedArticle[]> {
    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0) return [];

    const tokens = this.tokenize(query);
    if (tokens.length === 0) return [];

    const pool = Math.max(limit * 3, limit);
    const lists: number[][] = [await this.keywordCandidates(user.orgId, ids, tokens, pool)];

    if (this.embeddings.isConfigured()) {
      const vectorIds = await this.vectorCandidates(user.orgId, ids, query, pool);
      if (vectorIds.length > 0) lists.push(vectorIds);
    }

    const fused = this.fuse(lists).slice(0, limit);
    if (fused.length === 0) return [];

    const rows = await this.db
      .select({
        id: kbArticles.id,
        title: kbArticles.title,
        slug: kbArticles.slug,
        spaceId: kbArticles.spaceId,
        contentText: kbArticles.contentText,
      })
      .from(kbArticles)
      .where(and(eq(kbArticles.orgId, user.orgId), inArray(kbArticles.id, fused)));

    const order = new Map(fused.map((id, index) => [id, index]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  private async keywordCandidates(
    orgId: string,
    spaceIds: number[],
    tokens: string[],
    pool: number,
  ): Promise<number[]> {
    const conditions: SQL[] = [eq(kbArticles.orgId, orgId), inArray(kbArticles.spaceId, spaceIds)];
    const match = this.keywordMatch(tokens);
    if (match) conditions.push(match);

    const rows = await this.db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .where(and(...conditions))
      .orderBy(desc(this.keywordRank(tokens)), desc(kbArticles.updatedAt))
      .limit(pool);
    return rows.map((row) => row.id);
  }

  private async vectorCandidates(
    orgId: string,
    spaceIds: number[],
    query: string,
    pool: number,
  ): Promise<number[]> {
    try {
      const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));
      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
      const rows = await this.db
        .select({ articleId: kbArticleChunks.articleId })
        .from(kbArticleChunks)
        .innerJoin(kbArticles, eq(kbArticles.id, kbArticleChunks.articleId))
        .where(and(eq(kbArticleChunks.orgId, orgId), inArray(kbArticles.spaceId, spaceIds)))
        .orderBy(distance)
        .limit(pool * 4);

      const seen = new Set<number>();
      const result: number[] = [];
      for (const row of rows) {
        if (seen.has(row.articleId)) continue;
        seen.add(row.articleId);
        result.push(row.articleId);
        if (result.length >= pool) break;
      }
      return result;
    } catch {
      return [];
    }
  }

  private keywordMatch(tokens: string[]): SQL | undefined {
    const clauses = tokens
      .map((token) => {
        const term = `%${token}%`;
        return or(
          ilike(kbArticles.title, term),
          ilike(kbArticles.excerpt, term),
          ilike(kbArticles.contentText, term),
        );
      })
      .filter((clause): clause is SQL => Boolean(clause));
    return clauses.length > 0 ? or(...clauses) : undefined;
  }

  private keywordRank(tokens: string[]): SQL<number> {
    const parts = tokens.map((token) => {
      const term = `%${token}%`;
      return sql`(case when ${kbArticles.title} ilike ${term} then 3 else 0 end + case when ${kbArticles.excerpt} ilike ${term} then 2 else 0 end + case when ${kbArticles.contentText} ilike ${term} then 1 else 0 end)`;
    });
    return sql<number>`(${sql.join(parts, sql` + `)})`;
  }

  private tokenize(query: string): string[] {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3);
    const unique = [...new Set(tokens)].slice(0, 10);
    if (unique.length > 0) return unique;
    const fallback = query.trim().toLowerCase();
    return fallback ? [fallback] : [];
  }

  private fuse(lists: number[][]): number[] {
    const scores = new Map<number, number>();
    for (const list of lists) {
      list.forEach((id, rank) => {
        scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_CONSTANT + rank + 1));
      });
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  private buildSnippet(contentText: string, query: string): string {
    const text = contentText.trim();
    if (!text) return "";
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    const start = index > 0 ? index : 0;
    return text.slice(start, start + SNIPPET_LENGTH).trim();
  }
}
