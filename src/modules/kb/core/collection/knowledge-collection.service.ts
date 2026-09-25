import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbPageGrants, kbPages } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import {
  keysetAfterValue,
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../../common/pagination/keyset";
import { KnowledgeAuthorizationService } from "../authorization/knowledge-authorization.service";
import {
  buildSharedWithMeScope,
  buildVisiblePageScope,
} from "../authorization/knowledge-page-scope";
import {
  accessLevelsSatisfying,
  type KbActorStanding,
  type KbSharedWithMeScope,
} from "../authorization/knowledge-authorization.types";
import {
  collectionScopeTag,
  decodeCollectionCursor,
  encodeCollectionCursor,
  sortUsesTimestamp,
} from "./kb-page-collection-cursor";
import { kbPagePrefixTsQuery } from "./kb-page-text-query";
import type {
  KbPageCollectionFacets,
  KbPageCollectionItem,
  KbPageCollectionPage,
  KbPageCollectionQuery,
  KbPageCollectionSort,
  KbPageSharedBy,
  KbPageStatus,
} from "./knowledge-collection.types";

const COLLECTION_PROJECTION = {
  id: kbPages.id,
  title: kbPages.title,
  icon: kbPages.icon,
  coverImage: kbPages.coverImage,
  spaceId: kbPages.spaceId,
  projectId: kbPages.projectId,
  parentPageId: kbPages.parentPageId,
  status: kbPages.status,
  visibility: kbPages.visibility,
  contentType: kbPages.contentType,
  trustState: kbPages.trustState,
  ownerMembershipId: kbPages.ownerMembershipId,
  ownerUserId: kbPages.ownerUserId,
  createdById: kbPages.createdById,
  createdByMembershipId: kbPages.createdByMembershipId,
  lastEditedById: kbPages.lastEditedById,
  lastEditedByMembershipId: kbPages.lastEditedByMembershipId,
  createdAt: kbPages.createdAt,
  updatedAt: kbPages.updatedAt,
  deletedAt: kbPages.deletedAt,
  nextReviewAt: kbPages.nextReviewAt,
  verifiedUntil: kbPages.verifiedUntil,
  contentRevision: kbPages.contentRevision,
  aclRevision: kbPages.aclRevision,
} as const;

function sortColumn(sort: KbPageCollectionSort) {
  if (sort === "created_desc") return kbPages.createdAt;
  if (sort === "title_asc") return kbPages.title;
  return kbPages.updatedAt;
}

function emptyPage(limit: number): KbPageCollectionPage {
  return {
    data: [],
    pagination: { limit, hasMore: false, nextCursor: null },
    facets: null,
  };
}

@Injectable()
export class KnowledgeCollectionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async listPages(
    user: CurrentUserContext,
    query: KbPageCollectionQuery,
  ): Promise<KbPageCollectionPage> {
    const standing = await this.auth.resolveStanding(user);
    const scope = buildVisiblePageScope(standing, "view");
    const scopeTag = collectionScopeTag(query, scope.fingerprint);

    let shared: KbSharedWithMeScope | null = null;
    if (query.sharedWithMe === true) {
      shared = buildSharedWithMeScope(standing);
      if (shared === null) return emptyPage(query.limit);
    }

    const conditions: SQL<unknown>[] = [];

    if (query.owner === "me") {
      if (standing.membershipId === null) return emptyPage(query.limit);
      conditions.push(eq(kbPages.ownerMembershipId, standing.membershipId));
    } else if (query.ownerMembershipId !== undefined) {
      conditions.push(eq(kbPages.ownerMembershipId, query.ownerMembershipId));
    }

    conditions.push(
      query.deleted === true
        ? isNotNull(kbPages.deletedAt)
        : isNull(kbPages.deletedAt),
    );

    if (query.spaceId !== undefined) {
      conditions.push(eq(kbPages.spaceId, query.spaceId));
    }
    if (query.projectId !== undefined) {
      conditions.push(eq(kbPages.projectId, query.projectId));
    }
    if (query.status !== undefined && query.status.length > 0) {
      conditions.push(inArray(kbPages.status, [...query.status]));
    }
    if (query.verified !== undefined) {
      conditions.push(
        query.verified
          ? eq(kbPages.trustState, "verified")
          : ne(kbPages.trustState, "verified"),
      );
    }
    if (query.q !== undefined && query.q.trim().length > 0) {
      const tsquery = kbPagePrefixTsQuery(query.q);
      if (tsquery === null) return emptyPage(query.limit);
      conditions.push(sql`${kbPages}.fts @@ ${tsquery}`);
    }

    const filterConditions = [...conditions];

    const position = decodeCollectionCursor(query.cursor, scopeTag, query.sort);
    if (position !== null) {
      conditions.push(this.keysetBound(query.sort, position));
    }

    const column = sortColumn(query.sort);
    const selection = {
      ...COLLECTION_PROJECTION,
      cursorValue: sortUsesTimestamp(query.sort)
        ? microsecondCursorValue(column)
        : sql<string>`${kbPages.title}`,
    };

    const branchSelect = (branch: SQL<unknown>) =>
      this.db
        .select(selection)
        .from(kbPages)
        .where(and(branch, ...conditions));

    const rows =
      shared === null && scope.grantBranch !== null
        ? await branchSelect(scope.indexedBranch)
            .union(branchSelect(scope.grantBranch))
            .orderBy(...this.unionOrderTerms(query.sort))
            .limit(query.limit + 1)
        : await branchSelect(shared !== null ? shared.predicate : scope.predicate)
            .orderBy(
              ...(query.sort === "title_asc"
                ? [asc(kbPages.title), asc(kbPages.id)]
                : [desc(column), desc(kbPages.id)]),
            )
            .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept[kept.length - 1];

    const sharedBy =
      query.sharedWithMe === true
        ? await this.loadSharedBy(
            standing,
            kept.map(function pageId(row) {
              return row.id;
            }),
          )
        : new Map<number, KbPageSharedBy>();

    return {
      data: kept.map(function toItem(row): KbPageCollectionItem {
        const { cursorValue: _cursorValue, ...page } = row;
        return { ...page, sharedBy: sharedBy.get(row.id) ?? null };
      }),
      pagination: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? encodeCollectionCursor(scopeTag, {
                sortValue: last.cursorValue,
                id: last.id,
              })
            : null,
      },
      facets:
        query.facets === true
          ? await this.loadFacets(
              and(
                shared !== null ? shared.predicate : scope.predicate,
                ...filterConditions,
              ),
            )
          : null,
    };
  }

  private unionOrderTerms(sort: KbPageCollectionSort): SQL<unknown>[] {
    const direction = sort === "title_asc" ? sql`asc` : sql`desc`;
    return [
      sql`${sql.identifier("cursorValue")} ${direction}`,
      sql`${sql.identifier("id")} ${direction}`,
    ];
  }

  private keysetBound(
    sort: KbPageCollectionSort,
    position: { sortValue: string; id: number },
  ): SQL<unknown> {
    if (sort === "title_asc") {
      return keysetAfterValue(kbPages.title, kbPages.id, position);
    }
    return keysetBeforeMicros(sortColumn(sort), kbPages.id, position);
  }

  private async loadSharedBy(
    standing: KbActorStanding,
    pageIds: number[],
  ): Promise<Map<number, KbPageSharedBy>> {
    const byPage = new Map<number, KbPageSharedBy>();
    if (pageIds.length === 0) return byPage;

    const grantee: SQL<unknown>[] = [];
    if (standing.membershipId !== null) {
      grantee.push(eq(kbPageGrants.membershipId, standing.membershipId));
    }
    if (standing.roleSlugs.length > 0) {
      grantee.push(inArray(kbPageGrants.role, [...standing.roleSlugs]));
    }
    if (grantee.length === 0) return byPage;

    const rows = await this.db
      .select({
        pageId: kbPageGrants.pageId,
        access: kbPageGrants.access,
        grantedByMembershipId: kbPageGrants.grantedByMembershipId,
        createdAt: kbPageGrants.createdAt,
      })
      .from(kbPageGrants)
      .where(
        and(
          eq(kbPageGrants.orgId, standing.orgId),
          inArray(kbPageGrants.pageId, pageIds),
          isNull(kbPageGrants.revokedAt),
          inArray(kbPageGrants.access, [...accessLevelsSatisfying("view")]),
          grantee.length === 1
            ? grantee[0]
            : sql`(${sql.join(grantee, sql` OR `)})`,
        ),
      );

    const rank = { view: 1, comment: 2, edit: 3, manage: 4 } as const;
    for (const row of rows) {
      const held = byPage.get(row.pageId);
      if (held === undefined || rank[row.access] > rank[held.access]) {
        byPage.set(row.pageId, {
          membershipId: row.grantedByMembershipId,
          at: row.createdAt,
          access: row.access,
        });
      }
    }
    return byPage;
  }

  private async loadFacets(
    filter: SQL<unknown> | undefined,
  ): Promise<KbPageCollectionFacets> {
    const [byStatus, bySpace, byOwner] = await Promise.all([
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
        .select({
          ownerMembershipId: kbPages.ownerMembershipId,
          count: sql<number>`count(*)::int`,
        })
        .from(kbPages)
        .where(filter)
        .groupBy(kbPages.ownerMembershipId),
    ]);

    return {
      status: byStatus.map(function toStatusFacet(row) {
        return { value: row.value as KbPageStatus, count: row.count };
      }),
      space: bySpace,
      owner: byOwner,
    };
  }
}
