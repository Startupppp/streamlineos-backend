import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { KbSearchMetrics, KB_SEARCH_QUEUE_LANE } from "../core/telemetry/kb-search-metrics";
import { PROCESS_CELL_ID } from "../../../common/cell-resources/cell-id";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbEventsService } from "../core/kb-events.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { SearchInput } from "./dto/kb-ai.schemas";
import type { ScopedRead } from "../../access/scoped-read";
import { actingMembershipId } from "../../../common/auth/principal";
import { articleSpacePredicate, KbCandidateService, kbPageCoreProjection } from "./kb-candidate.service";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { AccessService } from "../../access/access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { articleOwnerScope, resolveArticleOwnerFilter } from "./kb-article-owner-scope";
import { encodeSearchCursor, decodeSearchCursor, searchScopeTag } from "./kb-page-search-cursor";

export const KB_SNIPPET_CONTENT_CAP = 500;

type SearchItem = {
  id: number;
  spaceId: number | null;
  categoryId: number | null;
  title: string;
  slug: string;
  excerpt: string | null;
  status: "draft" | "in_review" | "published" | "archived";
  updatedAt: Date;
  snippet: string;
};

type SearchResult = {
  items: SearchItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

@Injectable()
export class KbSearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly events: KbEventsService,
    private readonly candidates: KbCandidateService,
    private readonly scopes: AccessService,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async articleOwnerFilterFor(user: CurrentUserContext): Promise<SQL> {
    return resolveArticleOwnerFilter(this.scopes, user);
  }

  async aclCacheOutcome(user: CurrentUserContext): Promise<"hit" | "miss" | "bypass"> {
    const { cacheOutcome } = await this.auth.resolveAccessibleSpaces(user);
    return cacheOutcome;
  }

  async search(
    user: CurrentUserContext,
    input: SearchInput,
    scope: ScopedRead,
  ): Promise<SearchResult> {
    const metrics = KbSearchMetrics.begin({ orgId: user.orgId, actorStanding: user.isOrgOwner ? "owner" : "member", orgCell: PROCESS_CELL_ID });
    try {
      return await runInTenantTransaction(
        this.db,
        () => this.searchMeasured(user, input, scope, metrics),
        { orgId: user.orgId },
      );
    } catch (error) {
      metrics.finish("error");
      throw error;
    }
  }

  private async searchMeasured(
    user: CurrentUserContext,
    input: SearchInput,
    scope: ScopedRead,
    metrics: KbSearchMetrics,
  ): Promise<SearchResult> {
    const empty: SearchResult = {
      items: [],
      hasMore: false,
      nextCursor: null,
    };
    const dbRole = "primary";
    const queueLane = KB_SEARCH_QUEUE_LANE;
    const emptyKind = "none";
    if (scope.denied) {
      const scopeDeniedOutcome = "bypass";
      metrics.finish("denied", { sourceKind: emptyKind, cacheOutcome: scopeDeniedOutcome, queueLane, dbRole });
      return empty;
    }

    const { spaceIds: ids, cacheOutcome } = await this.auth.resolveAccessibleSpaces(user);
    const permFingerprint = [...ids].sort((a, b) => a - b).join(",");
    const scopeTag = searchScopeTag({ q: input.q, spaceId: input.spaceId }, permFingerprint);
    const position = decodeSearchCursor(input.cursor, scopeTag);

    const tsquery = sql`websearch_to_tsquery('english', ${input.q})`;
    const rankExpr = this.candidates.keywordRank(tsquery);
    const keywordCond = await this.candidates.resolveArticleKeywordCondition(
      input.q,
      tsquery,
      500,
    );
    const domain: SQL[] = [
      supportArticlePredicate(),
      articleSpacePredicate(ids),
      ne(kbPages.status, "archived"),
      keywordCond,
    ];
    const articleRestriction = await this.auth.articleRestrictionPredicate(user);
    if (articleRestriction) domain.push(articleRestriction);
    if (input.spaceId) domain.push(eq(kbPages.spaceId, input.spaceId));
    if (position !== null) {
      domain.push(
        sql`(${rankExpr}, ${kbPages.updatedAt}, ${kbPages.id}) < (${sql.param(Number(position.rank))}::real, ${sql.param(position.updatedAt)}::timestamp, ${sql.param(position.id, kbPages.id)})`,
      );
    }
    const membershipId =
      user.principal === undefined ? null : actingMembershipId(user.principal);
    const where = scope.compose(
      {
        tenant: kbPages.orgId,
        scope: articleOwnerScope(membershipId),
        and: domain,
      },
      ({ sql: composed }) => composed,
      () => sql`false`,
    );

    const rows = await this.db
      .select({
        ...kbPageCoreProjection,
        categoryId: kbPages.categoryId,
        excerpt: kbPages.excerpt,
        status: kbPages.status,
        contentText: sql<string | null>`left(${kbPages.contentText}, ${KB_SNIPPET_CONTENT_CAP})`,
        rankValue: sql<string>`${rankExpr}::text`,
        updatedAtValue: sql<string>`to_char(${kbPages.updatedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
      })
      .from(kbPages)
      .where(where)
      .orderBy(
        desc(rankExpr),
        desc(kbPages.updatedAt),
        desc(kbPages.id),
      )
      .limit(input.pageSize + 1);

    const hasMore = rows.length > input.pageSize;
    const kept = hasMore ? rows.slice(0, input.pageSize) : rows;
    const last = kept[kept.length - 1];

    const items = kept.map((row) => ({
      id: row.id,
      spaceId: row.spaceId,
      categoryId: row.categoryId,
      title: row.title,
      slug: row.slug ?? "",
      excerpt: row.excerpt,
      status: row.status,
      updatedAt: row.updatedAt,
      snippet: this.candidates.buildSnippet(row.contentText, input.q),
    }));

    await this.events.recordDetached(
      user.orgId,
      items.length > 0 ? "search" : "search_no_results",
      {
        actorMembershipId: actingMembershipId(user.principal) ?? null,
        query: input.q,
        metadata: { resultsCount: items.length },
      },
    );

    const nextCursor =
      hasMore && last !== undefined
        ? encodeSearchCursor(scopeTag, {
            rank: last.rankValue,
            updatedAt: last.updatedAtValue,
            id: last.id,
          })
        : null;

    const sourceKind = "article";
    metrics.finish(items.length > 0 ? "found" : "not_found", { results: items.length, sourceKind, cacheOutcome, queueLane, dbRole });
    return {
      items,
      hasMore,
      nextCursor,
    };
  }
}
