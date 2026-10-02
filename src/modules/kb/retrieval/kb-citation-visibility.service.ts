import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { kbPages, kbSources } from "../../../db/schema";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { wikiPagePredicate } from "../help-centre/kb-article-page-scope";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { articleSpacePredicate } from "./kb-candidate.service";
import { sourceSpaceFilter } from "./kb-requested-sources";
import { KbSearchService } from "./kb-search.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";

export type CitedRef =
  | { kind: "article"; id: number }
  | { kind: "page"; id: number }
  | { kind: "source"; id: number };

@Injectable()
export class KbCitationVisibilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly search: KbSearchService,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async partitionVisible(
    user: CurrentUserContext,
    refs: CitedRef[],
  ): Promise<{ visible: (ref: CitedRef) => boolean }> {
    const articleIds = refs.flatMap((r) =>
      r.kind === "article" ? [r.id] : [],
    );
    const pageIds = refs.flatMap((r) => (r.kind === "page" ? [r.id] : []));
    const sourceIds = refs.flatMap((r) => (r.kind === "source" ? [r.id] : []));

    const [articles, pages, sources] = await Promise.all([
      articleIds.length > 0
        ? this.visibleArticles(user, articleIds)
        : emptySet(),
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

  async visibleArticles(
    user: CurrentUserContext,
    ids: number[],
  ): Promise<Set<number>> {
    const spaceIds = (await this.auth.resolveStanding(user)).accessibleSpaceIds;
    const [ownerFilter, restrictionFilter] = await Promise.all([
      this.search.articleOwnerFilterFor(user),
      this.auth.articleRestrictionPredicate(user),
    ]);
    const conditions: SQL[] = [
      eq(kbPages.orgId, user.orgId),
      inArray(kbPages.id, ids),
      supportArticlePredicate(),
      articleSpacePredicate(spaceIds),
      eq(kbPages.status, "published"),
    ];
    if (ownerFilter) conditions.push(ownerFilter);
    if (restrictionFilter) conditions.push(restrictionFilter);
    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(and(...conditions));
    return new Set(rows.map((r) => r.id));
  }

  async visiblePages(
    user: CurrentUserContext,
    ids: number[],
  ): Promise<Set<number>> {
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, user.orgId),
          inArray(kbPages.id, ids),
          wikiPagePredicate(),
          ne(kbPages.status, "archived"),
          predicate,
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  async visibleSources(
    user: CurrentUserContext,
    ids: number[],
  ): Promise<Set<number>> {
    const accessibleSpaceIds = (await this.auth.resolveStanding(user)).accessibleSpaceIds;
    const spaceFilter = sourceSpaceFilter(accessibleSpaceIds);
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
