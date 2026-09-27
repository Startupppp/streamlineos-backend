import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  inArray,
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
import { KbCandidateService } from "./kb-candidate.service";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { AccessService } from "../../access/access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { articleOwnerScope, articleOwnerScopeFilter } from "./kb-article-owner-scope";

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
    const read = await resolveKbArticlesViewScope(this.scopes, user);
    return articleOwnerScopeFilter(read, user);
  }

  async aclCacheOutcome(user: CurrentUserContext): Promise<"hit" | "miss" | "bypass"> {
    const { cacheOutcome } = await this.auth.resolveAccessibleSpaces(user);
    return cacheOutcome;
  }

  async search(
    user: CurrentUserContext,
    input: SearchInput,
    scope: ScopedRead,
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
    const empty = {
      items: [],
      total: 0,
      page: input.page,
      pageSize: input.pageSize,
      totalPages: 0,
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
    if (ids.length === 0) {
      metrics.finish("not_found", { sourceKind: emptyKind, cacheOutcome, queueLane, dbRole });
      return empty;
    }

    const tsquery = sql`websearch_to_tsquery('english', ${input.q})`;
    const keywordCond = await this.candidates.resolveArticleKeywordCondition(
      input.q,
      tsquery,
      500,
    );
    const domain: SQL[] = [
      supportArticlePredicate(),
      inArray(kbPages.spaceId, ids),
      ne(kbPages.status, "archived"),
      keywordCond,
    ];
    const articleRestriction = await this.auth.articleRestrictionPredicate(user);
    if (articleRestriction) domain.push(articleRestriction);
    if (input.spaceId) domain.push(eq(kbPages.spaceId, input.spaceId));
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

    const offset = (input.page - 1) * input.pageSize;

    const rows = await this.db
      .select({
        id: kbPages.id,
        spaceId: kbPages.spaceId,
        categoryId: kbPages.categoryId,
        title: kbPages.title,
        slug: kbPages.slug,
        excerpt: kbPages.excerpt,
        status: kbPages.status,
        updatedAt: kbPages.updatedAt,
        contentText: kbPages.contentText,
      })
      .from(kbPages)
      .where(where)
      .orderBy(
        desc(this.candidates.keywordRank(tsquery)),
        desc(kbPages.updatedAt),
      )
      .limit(input.pageSize)
      .offset(offset);

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbPages)
      .where(where);
    const total = countRow?.count ?? 0;

    const items = rows.map(({ contentText, slug, ...card }) => ({
      ...card,
      slug: slug ?? "",
      snippet: this.candidates.buildSnippet(contentText, input.q),
    }));

    await this.events.recordDetached(
      user.orgId,
      total > 0 ? "search" : "search_no_results",
      {
        actorMembershipId: actingMembershipId(user.principal) ?? null,
        query: input.q,
        metadata: { resultsCount: total },
      },
    );

    const sourceKind = "article";
    metrics.finish(total > 0 ? "found" : "not_found", { results: total, sourceKind, cacheOutcome, queueLane, dbRole });
    return {
      items,
      total,
      page: input.page,
      pageSize: input.pageSize,
      totalPages: Math.ceil(total / input.pageSize),
    };
  }
}
