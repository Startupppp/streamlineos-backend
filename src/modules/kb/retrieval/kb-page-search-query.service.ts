import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
import { kbPagePrefixTsQuery } from "../core/collection/kb-page-text-query";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchScopeTag,
} from "./kb-page-search-cursor";
import type { PageFullSearchQuery, KbPageFullSearchResponse } from "./dto/kb-page-search-query.schemas";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export const FTS_ID_CAP = 500;

@Injectable()
export class KbPageSearchQueryService {
  private readonly logger = new Logger(KbPageSearchQueryService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async search(
    user: CurrentUserContext,
    input: PageFullSearchQuery,
  ): Promise<KbPageFullSearchResponse> {
    const tsquery = kbPagePrefixTsQuery(input.q);
    if (tsquery === null) {
      return {
        items: [],
        hasMore: false,
        nextCursor: null,
        limit: input.limit,
        facets: null,
      };
    }

    return runInTenantTransaction(
      this.db,
      async () => {
        const standing = await this.auth.resolveStanding(user);
        const scope = buildVisiblePageScope(standing, "view");
        const scopeTag = searchScopeTag(input, scope.fingerprint);
        const position = decodeSearchCursor(input.cursor, scopeTag);

        const ftsPredicate: SQL<unknown> = sql`${kbPages}.id IN (SELECT app.search_kb_page_ids(${input.q}, ${FTS_ID_CAP}))`;

        const baseConditions = this.buildBaseConditions(user.orgId, scope.predicate, ftsPredicate, input);
        const rankExpr = sql`ts_rank(${kbPages}.fts, ${tsquery})`;
        const conditions = [...baseConditions];
        if (position !== null) {
          conditions.push(
            sql`(${rankExpr}, ${kbPages.updatedAt}, ${kbPages.id}) < (${sql.param(Number(position.rank))}::real, ${sql.param(position.updatedAt)}::timestamp, ${sql.param(position.id, kbPages.id)})`,
          );
        }

        const rows = await this.db
          .select({
            id: kbPages.id,
            title: kbPages.title,
            spaceId: kbPages.spaceId,
            projectId: kbPages.projectId,
            status: kbPages.status,
            trustState: kbPages.trustState,
            visibility: kbPages.visibility,
            contentType: kbPages.contentType,
            updatedAt: kbPages.updatedAt,
            snippet: sql<string>`ts_headline('english', coalesce(${kbPages.contentText},''), ${tsquery}, 'MaxWords=20, MinWords=5')`,
            rankValue: sql<string>`${rankExpr}::text`,
            updatedAtValue: sql<string>`to_char(${kbPages.updatedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
          })
          .from(kbPages)
          .where(and(...conditions))
          .orderBy(desc(rankExpr), desc(kbPages.updatedAt), desc(kbPages.id))
          .limit(input.limit + 1);

        const hasMore = rows.length > input.limit;
        const kept = hasMore ? rows.slice(0, input.limit) : rows;
        const last = kept[kept.length - 1];

        const items = kept.map(function toItem({ rankValue: _rankValue, updatedAtValue: _updatedAtValue, ...item }) {
          return item;
        });

        const facets = input.facets
          ? await this.loadFacets(user.orgId, and(...baseConditions))
          : null;

        return {
          items,
          hasMore,
          nextCursor:
            hasMore && last !== undefined
              ? encodeSearchCursor(scopeTag, {
                  rank: last.rankValue,
                  updatedAt: last.updatedAtValue,
                  id: last.id,
                })
              : null,
          limit: input.limit,
          facets,
        };
      },
      { orgId: user.orgId },
    );
  }

  private buildBaseConditions(
    orgId: string,
    visibility: SQL<unknown>,
    ftsPredicate: SQL<unknown>,
    input: Pick<PageFullSearchQuery, "spaceId" | "status" | "type" | "verified">,
  ): SQL<unknown>[] {
    const conditions: SQL<unknown>[] = [
      eq(kbPages.orgId, orgId),
      isNull(kbPages.deletedAt),
      visibility,
      ftsPredicate,
    ];

    if (input.spaceId !== undefined) {
      conditions.push(eq(kbPages.spaceId, input.spaceId));
    }
    if (input.status !== undefined) {
      conditions.push(eq(kbPages.status, input.status));
    } else {
      conditions.push(ne(kbPages.status, "archived"));
    }
    if (input.type !== undefined) {
      conditions.push(eq(kbPages.contentType, input.type));
    }
    if (input.verified !== undefined) {
      conditions.push(
        input.verified
          ? eq(kbPages.trustState, "verified")
          : ne(kbPages.trustState, "verified"),
      );
    }

    return conditions;
  }

  private async loadFacets(
    orgId: string,
    filter: SQL<unknown> | undefined,
  ): Promise<KbPageFullSearchResponse["facets"]> {
    try {
      const [byStatus, bySpace, byType, byVerified] = await Promise.all([
        this.db
          .select({ value: kbPages.status, count: sql<number>`count(*)::int` })
          .from(kbPages)
          .where(filter)
          .groupBy(kbPages.status),
        this.db
          .select({ spaceId: kbPages.spaceId, count: sql<number>`count(*)::int` })
          .from(kbPages)
          .where(filter)
          .groupBy(kbPages.spaceId),
        this.db
          .select({ value: kbPages.contentType, count: sql<number>`count(*)::int` })
          .from(kbPages)
          .where(filter)
          .groupBy(kbPages.contentType),
        this.db
          .select({ value: kbPages.trustState, count: sql<number>`count(*)::int` })
          .from(kbPages)
          .where(filter)
          .groupBy(kbPages.trustState),
      ]);
      return {
        status: byStatus.map((row) => ({ value: row.value, count: row.count })),
        space: bySpace.map((row) => ({ spaceId: row.spaceId, count: row.count })),
        type: byType.map((row) => ({ value: row.value, count: row.count })),
        verified: byVerified.map((row) => ({ value: row.value, count: row.count })),
      };
    } catch (err) {
      this.logger.warn("KB page full-search facet load failed", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
