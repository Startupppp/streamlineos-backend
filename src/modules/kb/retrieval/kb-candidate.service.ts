import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleChunks, kbArticleRestrictions, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

const RRF_CONSTANT = 60;
const SNIPPET_LENGTH = 160;

@Injectable()
export class KbCandidateService {
  private readonly logger = new Logger(KbCandidateService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async hasEmbeddedChunks(orgId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: kbArticleChunks.id })
      .from(kbArticleChunks)
      .where(and(eq(kbArticleChunks.orgId, orgId), isNotNull(kbArticleChunks.embedding)))
      .limit(1);
    return row !== undefined;
  }

  async vectorChunkIds(vector: string, cap: number): Promise<number[]> {
    if (cap === 0) return [];
    await this.db.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    const annRows = await this.db.execute(
      sql`SELECT id FROM public.kb_article_chunks ORDER BY embedding <=> ${vector}::vector LIMIT ${cap}`,
    );
    const annIds = annRows.map((r) => Number(r["id"]));
    if (annIds.length > 0) return annIds;
    const fenceRows = await this.db.execute(
      sql`SELECT app.search_kb_chunk_ids(${vector}::vector, ${cap}) AS id`,
    );
    return fenceRows.map((r) => Number(r["id"]));
  }

  async articleKeywordCandidates(
    orgId: string,
    spaceIds: number[],
    query: string,
    pool: number,
    principal: { userId: string; membershipId: number | null; roleSlugs: string[] },
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

  async articleVectorCandidates(
    orgId: string,
    spaceIds: number[],
    vector: string,
    pool: number,
    principal: { userId: string; membershipId: number | null; roleSlugs: string[] },
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

  async pageKeywordCandidates(
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

  async pageVectorCandidates(
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

  articleRestrictionFilter(
    orgId: string,
    principal: { userId: string; membershipId: number | null; roleSlugs: string[] },
  ): SQL {
    const kar = kbArticleRestrictions;
    const membershipMatch =
      principal.membershipId !== null
        ? sql`${kar.membershipId} = ${principal.membershipId} OR `
        : sql``;
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
          AND (${membershipMatch}${
            principal.roleSlugs.length > 0
              ? sql`${kar.role} = ANY(${principal.roleSlugs})`
              : sql`false`
          })
      )
    )`;
  }

  async resolveArticleKeywordCondition(q: string, tsquery: SQL, cap: number): Promise<SQL> {
    const term = `%${q}%`;
    const fallback = sql`(fts @@ ${tsquery} or (numnode(${tsquery}) = 0 and (${kbArticles.title} ilike ${term} or ${kbArticles.excerpt} ilike ${term} or ${kbArticles.contentText} ilike ${term})))`;
    const rows = await this.db.execute(sql`SELECT app.search_kb_article_ids(${q}, ${cap + 1}) AS id`);
    if (rows.length === 0 || rows.length > cap) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(kbArticles.id, ids);
  }

  keywordRank(tsquery: SQL): SQL<number> {
    return sql<number>`ts_rank(fts, ${tsquery})`;
  }

  fuseKeys(lists: string[][]): string[] {
    const scores = new Map<string, number>();
    for (const list of lists) {
      list.forEach((key, rank) => {
        scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_CONSTANT + rank + 1));
      });
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  }

  buildSnippet(contentText: string | null, query: string): string {
    const text = (contentText ?? "").trim();
    if (!text) return "";
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    const start = index > 0 ? index : 0;
    return text.slice(start, start + SNIPPET_LENGTH).trim();
  }

  private async resolvePageKeywordCondition(q: string, cap: number, tsquery: SQL): Promise<SQL> {
    const term = `%${q}%`;
    const fallback = sql`(fts @@ ${tsquery} OR (numnode(${tsquery}) = 0 AND ${kbPages.title} ILIKE ${term}))`;
    const rows = await this.db.execute(sql`SELECT app.search_kb_page_ids(${q}, ${cap + 1}) AS id`);
    if (rows.length === 0 || rows.length > cap) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(kbPages.id, ids);
  }
}
