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
  visiblePageBranches,
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
import { effectiveTrustState, isVerifiedNow } from "../kb-page-trust-predicates";
import type {
  KbPageCollectionFacets,
  KbPageCollectionItem,
  KbPageCollectionPage,
  KbPageCollectionQuery,
  KbPageCollectionSort,
  KbPageSharedBy,
  KbPageStatus,
} from "./knowledge-collection.types";
import { KB_PAGE_COLLECTION_COUNT_CAP } from "./knowledge-collection.types";

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
  trustState: effectiveTrustState(),
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

const CURSOR_VALUE_ALIAS = "cursorValue";
const ID_ALIAS = "id";

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
    boundedCount: { count: 0, isExact: true },
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
    const branches = visiblePageBranches(standing, "view");
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
          ? isVerifiedNow()
          : sql`NOT (${isVerifiedNow()})`,
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
      cursorValue: (sortUsesTimestamp(query.sort)
        ? microsecondCursorValue(column)
        : sql<string>`${kbPages.title}`
      ).as(CURSOR_VALUE_ALIAS),
    };

    const columnOrderTerms =
      query.sort === "title_asc"
        ? [asc(kbPages.title), asc(kbPages.id)]
        : [desc(column), desc(kbPages.id)];

    const branchSelect = (branch: SQL<unknown>) =>
      this.db
        .select(selection)
        .from(kbPages)
        .where(and(branch, ...conditions))
        .orderBy(...columnOrderTerms)
        .limit(query.limit + 1);

    const rows =
      shared === null && branches.grantBranch !== null
        ? await branchSelect(branches.indexedBranch)
            .union(branchSelect(branches.grantBranch))
            .orderBy(...this.unionOrderTerms(query.sort))
            .limit(query.limit + 1)
        : await branchSelect(
            shared !== null ? shared.predicate : branches.indexedBranch,
          );

    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept[kept.length - 1];

    const countScope = and(
      shared !== null ? shared.predicate : scope.predicate,
      ...filterConditions,
    );
    const countProbe = await this.db
      .select({ _: sql`1` })
      .from(kbPages)
      .where(countScope)
      .limit(KB_PAGE_COLLECTION_COUNT_CAP + 1);
    const rawCount = countProbe.length;
    const countIsExact = rawCount <= KB_PAGE_COLLECTION_COUNT_CAP;

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
      boundedCount: {
        count: countIsExact ? rawCount : KB_PAGE_COLLECTION_COUNT_CAP,
        isExact: countIsExact,
      },
    };
  }

  private unionOrderTerms(sort: KbPageCollectionSort): SQL<unknown>[] {
    const direction = sort === "title_asc" ? sql`asc` : sql`desc`;
    return [
      sql`${sql.identifier(CURSOR_VALUE_ALIAS)} ${direction}`,
      sql`${sql.identifier(ID_ALIAS)} ${direction}`,
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
