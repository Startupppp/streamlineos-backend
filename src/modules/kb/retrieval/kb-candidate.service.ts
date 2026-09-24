import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { kbArticleChunks, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { resolveArticleKeywordSql } from "../core/kb-article-keyword-search";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { queryVectorChunkIds } from "./kb-vector-candidate-query";
import { buildArticleRestrictionPredicate } from "./kb-article-restriction-predicate";

const RRF_CONSTANT = 60;
const SNIPPET_LENGTH = 160;

export const KB_HELP_CENTRE_CONTENT_TYPE = "support_article";

/**
 * The complement of `supportArticlePredicate()` over the one `kb_pages` table.
 *
 * `kb_pages` holds help-centre articles and wiki pages together, and the two carry
 * different ACLs: an article is additionally narrowed by space membership, the owner
 * DataScope and `kb_page_restrictions`, none of which the page predicate consults.
 * Admitting an article through a page-shaped read would therefore drop those three
 * narrowings, and would also return the same row twice in a fused retrieval — once
 * keyed `a:<id>` and once keyed `p:<id>`.
 */
export function wikiPagePredicate(): SQL {
  return sql`(${isNull(kbPages.deletedAt)} AND ${ne(kbPages.contentType, KB_HELP_CENTRE_CONTENT_TYPE)})`;
}

@Injectable()
export class KbCandidateService {
  private readonly logger = new Logger(KbCandidateService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() @Inject(CacheService) private readonly cache: CacheService | null = null,
  ) {}

  async hasEmbeddedChunks(orgId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: kbArticleChunks.id })
      .from(kbArticleChunks)
      .where(and(eq(kbArticleChunks.orgId, orgId), isNotNull(kbArticleChunks.embedding)))
      .limit(1);
    return row !== undefined;
  }

  // Chosen before the query runs: an HNSW pass returns exactly `cap` rows even when it loses recall.
  async vectorChunkIds(orgId: string, vector: string, cap: number): Promise<number[]> {
    return queryVectorChunkIds(this.db, this.cache, orgId, vector, cap);
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
      eq(kbPages.orgId, orgId),
      supportArticlePredicate(),
      inArray(kbPages.spaceId, spaceIds),
      eq(kbPages.status, "published"),
      keywordCond,
      this.articleRestrictionFilter(orgId, principal),
    ];
    if (ownerScopeFilter) conditions.push(ownerScopeFilter);
    if (spaceId) conditions.push(eq(kbPages.spaceId, spaceId));

    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(and(...conditions))
      .orderBy(desc(this.keywordRank(tsquery)), desc(kbPages.updatedAt))
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
    const conditions: SQL[] = [
      inArray(kbPages.spaceId, spaceIds),
      eq(kbPages.status, "published"),
      supportArticlePredicate(),
      this.articleRestrictionFilter(orgId, principal),
    ];
    if (ownerScopeFilter) conditions.push(ownerScopeFilter);
    if (spaceId) conditions.push(eq(kbPages.spaceId, spaceId));
    return this.pageIdsNearest(orgId, vector, pool, conditions, "KB article");
  }

  async pageKeywordCandidates(
    orgId: string,
    query: string,
    pool: number,
    pageVisibility: SQL,
  ): Promise<number[]> {
    const tsquery = sql`websearch_to_tsquery('english', ${query})`;
    const keywordCond = await this.resolveArticleKeywordCondition(query, tsquery, pool);
    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          wikiPagePredicate(),
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
    return this.pageIdsNearest(
      orgId,
      vector,
      pool,
      [wikiPagePredicate(), chunkVisibility],
      "KB page",
    );
  }

  /**
   * The role half is `inArray`, not `= ANY(${roleSlugs})`.
   *
   * A bare JS array interpolated into a drizzle `sql` template does NOT become one array
   * parameter — it expands to a parenthesised parameter LIST. `ANY(($1, $2))` is
   * `op ANY/ALL (array) requires array on right side` and the one-slug case `ANY(($1))`
   * is `malformed array literal`, so this predicate threw for every non-admin caller
   * holding at least one role assignment, which is nearly every real user. It took down
   * `GET /kb/search` and `POST /kb/ask` outright through `articleKeywordCandidates` and
   * `resolveVisibleArticles`, and — worse, because it is silent — `articleVectorCandidates`
   * swallowed the same throw in its own catch and answered with an empty candidate list,
   * so semantic retrieval over restricted articles quietly returned nothing.
   */
  articleRestrictionFilter(
    orgId: string,
    principal: { userId: string; membershipId: number | null; roleSlugs: string[] },
  ): SQL {
    return buildArticleRestrictionPredicate(orgId, principal);
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

  /**
   * Both vector passes now read one table, so they differ only in the predicates their
   * caller supplies. The chunk-to-page join carries `acl_revision` equality with a plain
   * `=`: a chunk whose indexed ACL trails its page is not disclosed until reindexing
   * catches it up.
   */
  private async pageIdsNearest(
    orgId: string,
    vector: string,
    pool: number,
    extraConditions: SQL[],
    label: string,
  ): Promise<number[]> {
    try {
      const cap = pool * 4;
      const chunkIds = await this.vectorChunkIds(orgId, vector, cap);
      if (chunkIds.length === 0) return [];

      const rows = await this.db
        .select({ pageId: kbArticleChunks.pageId })
        .from(kbArticleChunks)
        .innerJoin(
          kbPages,
          and(
            eq(kbPages.id, kbArticleChunks.pageId),
            eq(kbArticleChunks.aclRevision, kbPages.aclRevision),
          ),
        )
        .where(
          and(
            eq(kbArticleChunks.orgId, orgId),
            eq(kbPages.orgId, orgId),
            inArray(kbArticleChunks.id, chunkIds),
            isNotNull(kbArticleChunks.pageId),
            ...extraConditions,
          ),
        )
        .orderBy(sql`${kbArticleChunks.embedding} <=> ${vector}::vector`)
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
      this.logger.warn(`${label} vector candidate retrieval failed`, {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
