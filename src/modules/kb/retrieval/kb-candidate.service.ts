import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { kbArticleChunks, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { resolveArticleKeywordSql } from "../core/kb-article-keyword-search";
import {
  supportArticlePredicate,
  wikiPagePredicate,
} from "../help-centre/kb-article-page-scope";
import { queryVectorChunkIds } from "./kb-vector-candidate-query";
import { buildArticleRestrictionBranch } from "../core/authorization/knowledge-page-scope";

const RRF_CONSTANT = 60;
const SNIPPET_LENGTH = 160;

@Injectable()
export class KbCandidateService {
  private readonly logger = new Logger(KbCandidateService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional()
    @Inject(CacheService)
    private readonly cache: CacheService | null = null,
  ) {}

  async hasEmbeddedChunks(orgId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: kbArticleChunks.id })
      .from(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.orgId, orgId),
          isNotNull(kbArticleChunks.embedding),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  // Chosen before the query runs: an HNSW pass returns exactly `cap` rows even when it loses recall.
  async vectorChunkIds(
    orgId: string,
    vector: string,
    cap: number,
  ): Promise<number[]> {
    return queryVectorChunkIds(this.db, this.cache, orgId, vector, cap);
  }

  async articleKeywordCandidates(
    orgId: string,
    spaceIds: number[],
    query: string,
    pool: number,
    principal: {
      userId: string;
      membershipId: number | null;
      roleSlugs: string[];
    },
    ownerScopeFilter: SQL | null,
    spaceId?: number,
  ): Promise<number[]> {
    const tsquery = sql`websearch_to_tsquery('english', ${query})`;
    const keywordCond = await this.resolveArticleKeywordCondition(
      query,
      tsquery,
      500,
    );
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
    principal: {
      userId: string;
      membershipId: number | null;
      roleSlugs: string[];
    },
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
    const keywordCond = await this.resolveArticleKeywordCondition(
      query,
      tsquery,
      pool,
    );
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

  articleRestrictionFilter(
    orgId: string,
    principal: {
      userId: string;
      membershipId: number | null;
      roleSlugs: string[];
    },
  ): SQL {
    return buildArticleRestrictionBranch(orgId, principal);
  }

  async resolveArticleKeywordCondition(
    q: string,
    tsquery: SQL,
    cap: number,
  ): Promise<SQL> {
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
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => key);
  }

  buildSnippet(contentText: string | null, query: string): string {
    const text = (contentText ?? "").trim();
    if (!text) return "";
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    const start = index > 0 ? index : 0;
    return text.slice(start, start + SNIPPET_LENGTH).trim();
  }

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
