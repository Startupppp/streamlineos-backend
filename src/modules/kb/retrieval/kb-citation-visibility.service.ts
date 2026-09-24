import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { kbArticles, kbPages, kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAccessService } from "../core/kb-access.service";
import { KbSearchService } from "./kb-search.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";

export type CitedRef =
  | { kind: "article"; id: number }
  | { kind: "page"; id: number }
  | { kind: "source"; id: number };

/**
 * The one place that answers "may THIS reader open THIS cited document, right now".
 *
 * Retrieval-time filtering is not enough for a citation, because a citation outlives the
 * query that produced it: `/kb/ask` re-checks before answering and again on replay, and a
 * research brief is stored and re-opened for months. Both go through here, so a document
 * restricted away after indexing stops being citable everywhere at once.
 */
@Injectable()
export class KbCitationVisibilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly search: KbSearchService,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async partitionVisible(
    user: CurrentUserContext,
    refs: CitedRef[],
  ): Promise<{ visible: (ref: CitedRef) => boolean }> {
    const articleIds = refs.flatMap((r) => (r.kind === "article" ? [r.id] : []));
    const pageIds = refs.flatMap((r) => (r.kind === "page" ? [r.id] : []));
    const sourceIds = refs.flatMap((r) => (r.kind === "source" ? [r.id] : []));

    const [articles, pages, sources] = await Promise.all([
      articleIds.length > 0 ? this.visibleArticles(user, articleIds) : emptySet(),
      pageIds.length > 0 ? this.visiblePages(user, pageIds) : emptySet(),
      sourceIds.length > 0 ? this.visibleSources(user, sourceIds) : emptySet(),
    ]);

    return {
      visible: (ref) =>
        ref.kind === "article"
          ? articles.has(ref.id)
          : ref.kind === "page"
            ? pages.has(ref.id)
            : sources.has(ref.id),
    };
  }

  /**
   * Re-verification, not a second retrieval — so it has to re-apply BOTH article ACL
   * dimensions, or it is blind to a revocation in exactly the window it exists to cover.
   *
   * It used to re-apply only org, accessible spaces, `status='published'` and the owner
   * DataScope. `kb_article_restrictions` — the per-article ACL that
   * `KbCandidateService.article{Keyword,Vector}Candidates` and
   * `KbSearchService.retrieveTopArticles` all push into the retrieval predicate — was
   * missing. An article restricted to another membership between the moment retrieval
   * picked it and the moment the model answered was still cited by title, slug and
   * space to a reader who could no longer open it.
   */
  async visibleArticles(user: CurrentUserContext, ids: number[]): Promise<Set<number>> {
    const spaceIds = await this.access.getAccessibleSpaceIds(user);
    if (spaceIds.length === 0) return new Set();
    const [ownerFilter, restrictionFilter] = await Promise.all([
      this.search.articleOwnerFilterFor(user),
      this.search.articleRestrictionFilterFor(user),
    ]);
    const conditions: SQL[] = [
      eq(kbArticles.orgId, user.orgId),
      inArray(kbArticles.id, ids),
      inArray(kbArticles.spaceId, spaceIds),
      eq(kbArticles.status, "published"),
    ];
    if (ownerFilter) conditions.push(ownerFilter);
    if (restrictionFilter) conditions.push(restrictionFilter);
    const rows = await this.db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .where(and(...conditions));
    return new Set(rows.map((r) => r.id));
  }

  async visiblePages(user: CurrentUserContext, ids: number[]): Promise<Set<number>> {
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, user.orgId),
          inArray(kbPages.id, ids),
          isNull(kbPages.deletedAt),
          ne(kbPages.status, "archived"),
          predicate,
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  async visibleSources(user: CurrentUserContext, ids: number[]): Promise<Set<number>> {
    const accessibleSpaceIds = await this.access.getAccessibleSpaceIds(user);
    const spaceFilter =
      accessibleSpaceIds.length > 0
        ? or(isNull(kbSources.spaceId), inArray(kbSources.spaceId, accessibleSpaceIds))
        : isNull(kbSources.spaceId);
    const rows = await this.db
      .select({ id: kbSources.id })
      .from(kbSources)
      .where(
        and(
          eq(kbSources.orgId, user.orgId),
          inArray(kbSources.id, ids),
          isNull(kbSources.deletedAt),
          eq(kbSources.status, "ready"),
          spaceFilter,
        ),
      );
    return new Set(rows.map((r) => r.id));
  }
}

function emptySet(): Promise<Set<number>> {
  return Promise.resolve(new Set<number>());
}
