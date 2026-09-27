import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import {
  kbSpaces,
  kbSpaceMembers,
  kbPages,
  organizationMembers,
  users,
} from "../../../db/schema";
import {
  supportArticlePredicate,
  wikiPagePredicate,
} from "../help-centre/kb-article-page-scope";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { actingMembershipId } from "../../../common/auth/principal";
import type { ScopedRead } from "../../access/scoped-read";
import { kbSpaceOwnerScope } from "../core/kb-scope";
import { kbSlugify } from "../core/kb.util";
import type {
  CreateSpaceInput,
  ListSpacesQuery,
  UpdateSpaceInput,
} from "../core/dto/kb.schemas";
import {
  buildCursorPage,
  decodeIntegerCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";

type SpaceRow = typeof kbSpaces.$inferSelect;

type SpaceListItem = Pick<
  SpaceRow,
  | "id"
  | "name"
  | "slug"
  | "description"
  | "audience"
  | "icon"
  | "isPublicHelpCenter"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
> & {
  articleCount: number;
  pageCount: number;
  memberCount: number;
  ownerName: string | null;
  pagesOverdueForReview: number;
};

@Injectable()
export class KbSpacesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly indexing: KbIndexingService,
    private readonly authz: KnowledgeAuthorizationService,
  ) {}

  async list(
    user: CurrentUserContext,
    scope: ScopedRead,
    query: ListSpacesQuery,
  ): Promise<CursorPage<SpaceListItem>> {
    if (scope.denied) {
      return {
        data: [],
        pagination: { limit: query.limit, hasMore: false, nextCursor: null },
      };
    }

    const ids = (await this.authz.resolveStanding(user)).accessibleSpaceIds;
    if (ids.length === 0) {
      return {
        data: [],
        pagination: { limit: query.limit, hasMore: false, nextCursor: null },
      };
    }

    const membershipId = actingMembershipId(user.principal) ?? 0;
    const position = decodeIntegerCursor(query.cursor);

    const domain = [
      inArray(kbSpaces.id, ids),
      isNull(kbSpaces.deletedAt),
      query.audience !== undefined
        ? eq(kbSpaces.audience, query.audience)
        : undefined,
      query.archived === true
        ? isNotNull(kbSpaces.archivedAt)
        : query.archived === false
          ? isNull(kbSpaces.archivedAt)
          : undefined,
      query.q ? sql`${kbSpaces.name} ILIKE ${"%" + query.q + "%"}` : undefined,
      position
        ? keysetBeforeMicros(kbSpaces.updatedAt, kbSpaces.id, {
            sortValue: String(position.sortValue),
            id: position.id,
          })
        : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const where = scope.compose(
      {
        tenant: kbSpaces.orgId,
        scope: kbSpaceOwnerScope(membershipId),
        and: domain,
      },
      ({ sql: composed }) => composed,
      () => sql`false`,
    );

    const spaces = await this.db
      .select({
        id: kbSpaces.id,
        name: kbSpaces.name,
        slug: kbSpaces.slug,
        description: kbSpaces.description,
        audience: kbSpaces.audience,
        icon: kbSpaces.icon,
        isPublicHelpCenter: kbSpaces.isPublicHelpCenter,
        createdAt: kbSpaces.createdAt,
        updatedAt: kbSpaces.updatedAt,
        archivedAt: kbSpaces.archivedAt,
        updatedAtMicros: microsecondCursorValue(kbSpaces.updatedAt),
        ownerName: users.name,
      })
      .from(kbSpaces)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, kbSpaces.orgId),
          eq(organizationMembers.id, kbSpaces.createdByMembershipId),
        ),
      )
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(where)
      .orderBy(desc(kbSpaces.updatedAt), desc(kbSpaces.id))
      .limit(query.limit + 1);

    const spaceIds = spaces.map((s) => s.id);
    if (spaceIds.length === 0) {
      return {
        data: [],
        pagination: { limit: query.limit, hasMore: false, nextCursor: null },
      };
    }

    const visiblePagePredicate = await this.authz.visiblePagePredicate(user);

    const [articleCounts, pageCounts, memberCounts, overdueReviewCounts] = await Promise.all([
      this.db
        .select({
          spaceId: kbPages.spaceId,
          count: sql<number>`count(*)::int`,
        })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, user.orgId),
            inArray(kbPages.spaceId, spaceIds),
            supportArticlePredicate(),
          ),
        )
        .groupBy(kbPages.spaceId),
      this.db
        .select({
          spaceId: kbPages.spaceId,
          count: sql<number>`count(*)::int`,
        })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, user.orgId),
            inArray(kbPages.spaceId, spaceIds),
            wikiPagePredicate(),
            visiblePagePredicate,
          ),
        )
        .groupBy(kbPages.spaceId),
      this.db
        .select({
          spaceId: kbSpaceMembers.spaceId,
          count: sql<number>`count(*)::int`,
        })
        .from(kbSpaceMembers)
        .where(
          and(
            eq(kbSpaceMembers.orgId, user.orgId),
            inArray(kbSpaceMembers.spaceId, spaceIds),
          ),
        )
        .groupBy(kbSpaceMembers.spaceId),
      this.db
        .select({
          spaceId: kbPages.spaceId,
          count: sql<number>`count(*)::int`,
        })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, user.orgId),
            inArray(kbPages.spaceId, spaceIds),
            isNull(kbPages.deletedAt),
            isNotNull(kbPages.nextReviewAt),
            lt(kbPages.nextReviewAt, new Date()),
          ),
        )
        .groupBy(kbPages.spaceId),
    ]);

    const articleCountMap = new Map(
      articleCounts.map((c) => [c.spaceId, c.count]),
    );
    const pageCountMap = new Map(pageCounts.map((c) => [c.spaceId, c.count]));
    const memberCountMap = new Map(
      memberCounts.map((c) => [c.spaceId, c.count]),
    );
    const overdueReviewCountMap = new Map(
      overdueReviewCounts.map((c) => [c.spaceId, c.count]),
    );

    const cursorValues = new Map(spaces.map((s) => [s.id, s.updatedAtMicros]));

    const items = spaces.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      description: s.description,
      audience: s.audience,
      icon: s.icon,
      isPublicHelpCenter: s.isPublicHelpCenter,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      archivedAt: s.archivedAt,
      articleCount: articleCountMap.get(s.id) ?? 0,
      pageCount: pageCountMap.get(s.id) ?? 0,
      memberCount: memberCountMap.get(s.id) ?? 0,
      ownerName: s.ownerName ?? null,
      pagesOverdueForReview: overdueReviewCountMap.get(s.id) ?? 0,
    }));

    return buildCursorPage(items, query.limit, (row) => ({
      sortValue: cursorValues.get(row.id) ?? row.updatedAt.toISOString(),
      id: String(row.id),
    }));
  }

  async create(
    orgId: string,
    input: CreateSpaceInput,
    membershipId: number,
  ): Promise<SpaceRow> {
    const slug = kbSlugify(input.name);
    if (!slug) throw new ConflictException("Invalid space name");
    const existing = await this.db.query.kbSpaces.findFirst({
      where: and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.slug, slug)),
      columns: { id: true },
    });
    if (existing)
      throw new ConflictException("A space with this name already exists");
    const created = await this.db.transaction(async (tx) => {
      const [space] = await tx
        .insert(kbSpaces)
        .values({
          orgId,
          name: input.name,
          slug,
          description: input.description ?? null,
          audience: input.audience,
          icon: input.icon ?? null,
          isPublicHelpCenter: input.isPublicHelpCenter ?? false,
          createdByMembershipId: membershipId,
        })
        .returning();
      await tx.insert(kbSpaceMembers).values({
        orgId,
        spaceId: space.id,
        membershipId,
        spaceRole: "admin",
      });
      return space;
    });
    await this.authz.invalidateSpaceScope(orgId);
    return created;
  }

  async get(
    user: CurrentUserContext,
    spaceId: number,
  ): Promise<{
    id: number;
    orgId: string;
    name: string;
    slug: string;
    description: string | null;
    audience: "internal" | "public" | "mixed";
    icon: string | null;
    branding: Record<string, unknown> | null;
    isPublicHelpCenter: boolean;
    createdByMembershipId: number | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    type: string;
    color: string | null;
    defaultVisibility: string;
    owningTeamId: string | null;
    archivedAt: Date | null;
    ownerName: string | null;
    pagesOverdueForReview: number;
    pagesWithReviewPolicy: number;
    viewerSpaceRole: string | null;
  }> {
    const [spaceRow] = await this.db
      .select({
        id: kbSpaces.id,
        orgId: kbSpaces.orgId,
        name: kbSpaces.name,
        slug: kbSpaces.slug,
        description: kbSpaces.description,
        audience: kbSpaces.audience,
        icon: kbSpaces.icon,
        branding: kbSpaces.branding,
        isPublicHelpCenter: kbSpaces.isPublicHelpCenter,
        createdByMembershipId: kbSpaces.createdByMembershipId,
        createdAt: kbSpaces.createdAt,
        updatedAt: kbSpaces.updatedAt,
        deletedAt: kbSpaces.deletedAt,
        type: kbSpaces.type,
        color: kbSpaces.color,
        defaultVisibility: kbSpaces.defaultVisibility,
        owningTeamId: kbSpaces.owningTeamId,
        archivedAt: kbSpaces.archivedAt,
        ownerName: users.name,
      })
      .from(kbSpaces)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, kbSpaces.orgId),
          eq(organizationMembers.id, kbSpaces.createdByMembershipId),
        ),
      )
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(kbSpaces.id, spaceId),
          eq(kbSpaces.orgId, user.orgId),
          isNull(kbSpaces.deletedAt),
        ),
      );

    if (!spaceRow) throw new NotFoundException("Space not found");
    await this.authz.assertSpaceAccess(user, spaceId, "view");

    const membershipId = actingMembershipId(user.principal);

    const [overdueResult, policyResult, memberRow] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, user.orgId),
            eq(kbPages.spaceId, spaceId),
            isNull(kbPages.deletedAt),
            isNotNull(kbPages.nextReviewAt),
            lt(kbPages.nextReviewAt, new Date()),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, user.orgId),
            eq(kbPages.spaceId, spaceId),
            isNull(kbPages.deletedAt),
            isNotNull(kbPages.nextReviewAt),
          ),
        ),
      membershipId !== null
        ? this.db
            .select({ spaceRole: kbSpaceMembers.spaceRole })
            .from(kbSpaceMembers)
            .where(
              and(
                eq(kbSpaceMembers.orgId, user.orgId),
                eq(kbSpaceMembers.spaceId, spaceId),
                eq(kbSpaceMembers.membershipId, membershipId),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);

    return {
      ...spaceRow,
      pagesOverdueForReview: overdueResult[0]?.count ?? 0,
      pagesWithReviewPolicy: policyResult[0]?.count ?? 0,
      viewerSpaceRole: memberRow[0]?.spaceRole ?? null,
    };
  }

  async update(
    orgId: string,
    spaceId: number,
    input: UpdateSpaceInput,
  ): Promise<SpaceRow> {
    const values: Partial<typeof kbSpaces.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.description !== undefined)
      values.description = input.description ?? null;
    if (input.audience !== undefined) values.audience = input.audience;
    if (input.icon !== undefined) values.icon = input.icon ?? null;
    if (input.isPublicHelpCenter !== undefined)
      values.isPublicHelpCenter = input.isPublicHelpCenter;
    if (input.name !== undefined) {
      const slug = kbSlugify(input.name);
      if (!slug) throw new ConflictException("Invalid space name");
      const clash = await this.db.query.kbSpaces.findFirst({
        where: and(
          eq(kbSpaces.orgId, orgId),
          eq(kbSpaces.slug, slug),
          ne(kbSpaces.id, spaceId),
        ),
        columns: { id: true },
      });
      if (clash)
        throw new ConflictException("A space with this name already exists");
      values.name = input.name;
      values.slug = slug;
    }
    const aclChanged =
      input.audience !== undefined || input.isPublicHelpCenter !== undefined;
    const [updated] = await this.db
      .update(kbSpaces)
      .set(values)
      .where(and(eq(kbSpaces.id, spaceId), eq(kbSpaces.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Space not found");
    if (aclChanged) await this.indexing.bumpSpaceAclRevision(orgId, spaceId);
    await this.authz.invalidateSpaceScope(orgId);
    return updated;
  }

}
