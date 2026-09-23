import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { kbPagePrefixTsQuery } from "../core/collection/kb-page-text-query";
import type { PageFullSearchQuery, KbPageFullSearchResponse } from "./dto/kb-page-search-query.schemas";

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
      return { items: [], hasMore: false, limit: input.limit, facets: null };
    }

    const visibility = await this.auth.visiblePagePredicate(user, "view");
    const baseConditions = this.buildBaseConditions(user.orgId, visibility, tsquery, input);

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
      })
      .from(kbPages)
      .where(and(...baseConditions))
      .orderBy(
        desc(sql`ts_rank(${kbPages}.fts, ${tsquery})`),
        desc(kbPages.updatedAt),
        desc(kbPages.id),
      )
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;

    const facets = input.facets
      ? await this.loadFacets(and(...baseConditions))
      : null;

    return { items, hasMore, limit: input.limit, facets };
  }

  private buildBaseConditions(
    orgId: string,
    visibility: SQL<unknown>,
    tsquery: SQL<unknown>,
    input: Pick<PageFullSearchQuery, "spaceId" | "status" | "verified">,
  ): SQL<unknown>[] {
    const conditions: SQL<unknown>[] = [
      eq(kbPages.orgId, orgId),
      isNull(kbPages.deletedAt),
      visibility,
      sql`${kbPages}.fts @@ ${tsquery}`,
    ];

    if (input.spaceId !== undefined) {
      conditions.push(eq(kbPages.spaceId, input.spaceId));
    }
    if (input.status !== undefined) {
      conditions.push(eq(kbPages.status, input.status));
    } else {
      conditions.push(ne(kbPages.status, "archived"));
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
    filter: SQL<unknown> | undefined,
  ): Promise<KbPageFullSearchResponse["facets"]> {
    try {
      const [byStatus, bySpace] = await Promise.all([
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
      ]);
      return {
        status: byStatus.map((row) => ({ value: row.value, count: row.count })),
        space: bySpace.map((row) => ({ spaceId: row.spaceId, count: row.count })),
      };
    } catch (err) {
      this.logger.warn("KB page full-search facet load failed", {
        orgId: undefined,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
