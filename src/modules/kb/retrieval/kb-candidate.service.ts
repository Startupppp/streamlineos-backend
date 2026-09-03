import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleChunks, kbArticleRestrictions, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { resolveArticleKeywordSql } from "../core/kb-article-keyword-search";

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

  /**
   * The ids of the tenant's `cap` nearest chunks — a FULL pool, or every chunk it has.
   *
   * The cheap pass is the HNSW index. Its tenant restriction is a filter sitting on top of
   * the index scan, so the scan stops when the index runs out of tuples, not when `cap`
   * tenant rows have survived: measured on a 54,000-chunk table whose target tenant owned
   * 25,200, `LIMIT 240` came back with **50** rows and `Rows Removed by Filter: 1103`.
   * Nothing tunes that away — `hnsw.iterative_scan` off/relaxed/strict, `ef_search`
   * 40/400/1000, `max_scan_tuples` 500,000, `scan_mem_multiplier` 32 and the
   * `app.search_kb_chunk_ids` fence all returned the same 50 — and it is not RLS: an
   * explicit `org_id = '…'` constant under the table owner returns 50 as well.
   *
   * So the short pool is a fact of filtered ANN, and the only defect that matters is that
   * the old code returned it as if it were the answer: the fallback was gated on
   * `annIds.length > 0`, and 50 > 0. `/kb/ask` then answered "I don't have that
   * information" from a fifth of the candidates it asked for, with no error and no log.
   *
   * The pool is therefore taken only when it is FULL, and a short one is redone exactly,
   * scoped to the tenant. `OFFSET 0` is an optimisation fence: without it the planner
   * pushes the `ORDER BY` back into the HNSW index and the second pass is as approximate
   * as the first. The exact pass costs one pass over the tenant's chunks (measured: 240 ms
   * / 101,825 buffers at 25,200 chunks; 5,383 buffers at 1,200), which is the price of a
   * correct answer on a shared index — a per-tenant HNSW index, i.e. partitioning
   * `kb_article_chunks` by `org_id`, is the only thing that makes it cheap as well.
   */
  async vectorChunkIds(orgId: string, vector: string, cap: number): Promise<number[]> {
    if (cap === 0) return [];
    await this.db.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    const annRows = await this.db.execute(
      sql`SELECT id FROM public.kb_article_chunks
          WHERE org_id = ${orgId}
          ORDER BY embedding <=> ${vector}::vector
          LIMIT ${cap}`,
    );
    const annIds = annRows.map((r) => Number(r["id"]));
    if (annIds.length >= cap) return annIds;

    const exactRows = await this.db.execute(
      sql`SELECT id FROM (
            SELECT id, embedding <=> ${vector}::vector AS distance
            FROM public.kb_article_chunks
            WHERE org_id = ${orgId}
            OFFSET 0
          ) scoped
          ORDER BY scoped.distance
          LIMIT ${cap}`,
    );
    const exactIds = exactRows.map((r) => Number(r["id"]));
    if (exactIds.length > annIds.length)
      this.logger.warn("KB vector ANN pass returned a short candidate pool — re-ran it exactly", {
        orgId,
        cap,
        annRows: annIds.length,
        exactRows: exactIds.length,
      });
    return exactIds;
  }

  async articleKeywordCandidates(
    orgId: string,
    spaceIds: number[],
    query: string,
    pool: number,
    principal: { userId: string; membershipId: number | null; roleSlugs: string[] },
    ownerScopeFilter: SQL | null,
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
    if (ownerScopeFilter) conditions.push(ownerScopeFilter);
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
    ownerScopeFilter: SQL | null,
    spaceId?: number,
  ): Promise<number[]> {
    try {
      const cap = pool * 4;
      const chunkIds = await this.vectorChunkIds(orgId, vector, cap);
      if (chunkIds.length === 0) return [];

      const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
      const conditions: SQL[] = [
        inArray(kbArticleChunks.id, chunkIds),
        isNotNull(kbArticleChunks.articleId),
        inArray(kbArticles.spaceId, spaceIds),
        eq(kbArticles.status, "published"),
        this.articleRestrictionFilter(orgId, principal),
      ];
      if (ownerScopeFilter) conditions.push(ownerScopeFilter);
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
      const chunkIds = await this.vectorChunkIds(orgId, vector, cap);
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
    return resolveArticleKeywordSql(this.db, q, tsquery, cap);
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
