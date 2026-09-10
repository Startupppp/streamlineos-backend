import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  kbSpaces,
  kbSpaceMembers,
  kbArticles,
  kbPages,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAccessService } from "../core/kb-access.service";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { actingMembershipId } from "../../../common/auth/principal";
import type { ScopedRead } from "../../access/scoped-read";
import { kbSpaceOwnerScope } from "../core/kb-scope";
import { kbSlugify } from "../core/kb.util";
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type {
  CreateSpaceInput,
  UpdateSpaceInput,
} from "../core/dto/kb.schemas";

const SPACE_CONTENT_BATCH_SIZE = 500;

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
> & { articleCount: number };

@Injectable()
export class KbSpacesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly indexing: KbIndexingService,
  ) {}

  async list(user: CurrentUserContext, scope: ScopedRead): Promise<SpaceListItem[]> {
    if (scope.denied) return [];

    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0) return [];

    const domain = [inArray(kbSpaces.id, ids), isNull(kbSpaces.deletedAt)];
    const membershipId = actingMembershipId(user.principal) ?? 0;
    const where = scope.compose(
      { tenant: kbSpaces.orgId, scope: kbSpaceOwnerScope(membershipId), and: domain },
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
      })
      .from(kbSpaces)
      .where(where)
      .orderBy(desc(kbSpaces.updatedAt));
    const counts = await this.db
      .select({
        spaceId: kbArticles.spaceId,
        count: sql<number>`count(*)::int`,
      })
      .from(kbArticles)
      .where(
        and(eq(kbArticles.orgId, user.orgId), inArray(kbArticles.spaceId, ids)),
      )
      .groupBy(kbArticles.spaceId);
    const countMap = new Map(counts.map((c) => [c.spaceId, c.count]));
    return spaces.map((s) => ({ ...s, articleCount: countMap.get(s.id) ?? 0 }));
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
            .select({ id: kbArticles.id })
            .from(kbArticles)
            .where(
              and(
                eq(kbArticles.orgId, orgId),
                eq(kbArticles.spaceId, spaceId),
                gt(kbArticles.id, afterId),
              ),
            )
            .orderBy(asc(kbArticles.id))
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

  /**
   * Keyset-batched inside the space's own transaction: the events must commit
   * with the soft delete, so they cannot move to a transaction of their own, but
   * a space holding tens of thousands of pages must not be read into one array.
   */
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
