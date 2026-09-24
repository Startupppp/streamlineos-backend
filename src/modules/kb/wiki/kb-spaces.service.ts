import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { kbSpaces, kbSpaceMembers, kbPages, kbPageLinks } from "../../../db/schema";
import { SUPPORT_ARTICLE_CONTENT_TYPE, supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAccessService } from "../core/kb-access.service";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { actingMembershipId } from "../../../common/auth/principal";
import type { ScopedRead } from "../../access/scoped-read";
import { kbSpaceOwnerScope } from "../core/kb-scope";
import { kbSlugify } from "../core/kb.util";
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type {
  CreateSpaceInput,
  ListSpacesQuery,
  UpdateSpaceInput,
} from "../core/dto/kb.schemas";
import {
  buildCursorPage,
  decodeCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";

const SPACE_CONTENT_BATCH_SIZE = 500;

const isWikiPage = () => ne(kbPages.contentType, SUPPORT_ARTICLE_CONTENT_TYPE);

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
> & { articleCount: number; pageCount: number; memberCount: number };

export interface SpaceArchiveImpact {
  pageCount: number;
  publicLinkCount: number;
  recordLinkCount: number;
  askIndexed: boolean;
}

@Injectable()
export class KbSpacesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
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

    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0) {
      return {
        data: [],
        pagination: { limit: query.limit, hasMore: false, nextCursor: null },
      };
    }

    const membershipId = actingMembershipId(user.principal) ?? 0;
    const position = decodeCursor(query.cursor);

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
            id: Number(position.id),
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
      })
      .from(kbSpaces)
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

    const [articleCounts, pageCounts, memberCounts] = await Promise.all([
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
            isNull(kbPages.deletedAt),
            isWikiPage(),
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
    ]);

    const articleCountMap = new Map(
      articleCounts.map((c) => [c.spaceId, c.count]),
    );
    const pageCountMap = new Map(pageCounts.map((c) => [c.spaceId, c.count]));
    const memberCountMap = new Map(
      memberCounts.map((c) => [c.spaceId, c.count]),
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
    await this.access.invalidateAccessibleSpaceIds(orgId);
    return created;
  }

  async get(user: CurrentUserContext, spaceId: number): Promise<SpaceRow> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, user.orgId),
        isNull(kbSpaces.deletedAt),
      ),
    });
    if (!space) throw new NotFoundException("Space not found");
    await this.access.assertSpaceAccessible(user, spaceId);
    return space;
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
    await this.access.invalidateAccessibleSpaceIds(orgId);
    return updated;
  }

  async archive(orgId: string, spaceId: number): Promise<{ success: boolean }> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true },
    });
    if (!space) throw new NotFoundException("Space not found");

    await this.db
      .update(kbSpaces)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(kbSpaces.id, spaceId),
          eq(kbSpaces.orgId, orgId),
          isNull(kbSpaces.archivedAt),
        ),
      );

    return { success: true };
  }

  async restore(orgId: string, spaceId: number): Promise<{ success: boolean }> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true },
    });
    if (!space) throw new NotFoundException("Space not found");

    await this.db
      .update(kbSpaces)
      .set({ archivedAt: null })
      .where(and(eq(kbSpaces.id, spaceId), eq(kbSpaces.orgId, orgId)));

    return { success: true };
  }

  async archiveImpact(
    orgId: string,
    spaceId: number,
  ): Promise<SpaceArchiveImpact> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true },
    });
    if (!space) throw new NotFoundException("Space not found");

    const [pageResult, publicResult, recordResult] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.spaceId, spaceId),
            isNull(kbPages.deletedAt),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.spaceId, spaceId),
            isNull(kbPages.deletedAt),
            isNotNull(kbPages.publicToken),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPageLinks)
        .innerJoin(
          kbPages,
          and(
            eq(kbPageLinks.orgId, orgId),
            eq(kbPageLinks.sourcePageId, kbPages.id),
          ),
        )
        .where(
          and(
            eq(kbPages.spaceId, spaceId),
            isNull(kbPages.deletedAt),
            isNotNull(kbPageLinks.targetId),
          ),
        ),
    ]);

    const pageCount = pageResult[0]?.count ?? 0;
    const publicLinkCount = publicResult[0]?.count ?? 0;
    const recordLinkCount = recordResult[0]?.count ?? 0;

    return {
      pageCount,
      publicLinkCount,
      recordLinkCount,
      askIndexed: pageCount > 0,
    };
  }

  async remove(orgId: string, spaceId: number): Promise<{ success: boolean }> {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [deleted] = await tx
          .update(kbSpaces)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(kbSpaces.id, spaceId),
              eq(kbSpaces.orgId, orgId),
              isNull(kbSpaces.deletedAt),
            ),
          )
          .returning({ id: kbSpaces.id });
        if (!deleted) throw new NotFoundException("Space not found");

        await this.emitContentDeletes(tx, orgId, "article", (afterId) =>
          tx
            .select({ id: kbPages.id })
            .from(kbPages)
            .where(
              and(
                eq(kbPages.orgId, orgId),
                eq(kbPages.spaceId, spaceId),
                supportArticlePredicate(),
                gt(kbPages.id, afterId),
              ),
            )
            .orderBy(asc(kbPages.id))
            .limit(SPACE_CONTENT_BATCH_SIZE),
        );
        await this.emitContentDeletes(tx, orgId, "page", (afterId) =>
          tx
            .select({ id: kbPages.id })
            .from(kbPages)
            .where(
              and(
                eq(kbPages.orgId, orgId),
                eq(kbPages.spaceId, spaceId),
                isWikiPage(),
                gt(kbPages.id, afterId),
              ),
            )
            .orderBy(asc(kbPages.id))
            .limit(SPACE_CONTENT_BATCH_SIZE),
        );
      },
      { orgId },
    );
    await this.access.invalidateAccessibleSpaceIds(orgId);
    return { success: true };
  }

  private async emitContentDeletes(
    tx: TenantTx,
    orgId: string,
    contentType: "article" | "page",
    nextBatch: (afterId: number) => Promise<{ id: number }[]>,
  ): Promise<void> {
    const aggregateType = contentType === "article" ? "kb_article" : "kb_page";
    let afterId = 0;
    for (;;) {
      const rows = await nextBatch(afterId);
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      afterId = last.id;

      const occurredAt = new Date();
      await OutboxWriter.emitMany(
        tx,
        rows.map((row) => ({
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType,
          aggregateId: String(row.id),
          aggregateVersion: occurredAt.getTime(),
          eventType: "kb.content.delete",
          payload: { contentType, contentId: row.id },
          occurredAt,
        })),
      );

      if (rows.length < SPACE_CONTENT_BATCH_SIZE) break;
    }
  }
}
