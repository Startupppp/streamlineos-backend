import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { kbCategories } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAccessService } from "../core/kb-access.service";
import { kbSlugify, KB_MAX_COLLECTION_DEPTH } from "../core/kb.util";
import type { CreateCategoryInput, UpdateCategoryInput } from "../core/dto/kb.schemas";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

type CategoryRow = typeof kbCategories.$inferSelect;

const KB_CATEGORY_LIST_COLUMNS = {
  id: kbCategories.id,
  orgId: kbCategories.orgId,
  spaceId: kbCategories.spaceId,
  parentId: kbCategories.parentId,
  name: kbCategories.name,
  slug: kbCategories.slug,
  description: kbCategories.description,
  icon: kbCategories.icon,
  sortOrder: kbCategories.sortOrder,
  isPublished: kbCategories.isPublished,
  createdAt: kbCategories.createdAt,
  updatedAt: kbCategories.updatedAt,
} as const;

@Injectable()
export class KbCategoriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
  ) {}

  async listBySpace(user: CurrentUserContext, spaceId: number): Promise<CategoryRow[]> {
    await this.access.assertSpaceAccessible(user, spaceId);
    return this.db
      .select(KB_CATEGORY_LIST_COLUMNS)
      .from(kbCategories)
      .where(and(eq(kbCategories.orgId, user.orgId), eq(kbCategories.spaceId, spaceId)))
      .orderBy(asc(kbCategories.sortOrder), asc(kbCategories.name))
      .limit(PAGE_SIZE_CAP);
  }

  async create(user: CurrentUserContext, spaceId: number, input: CreateCategoryInput): Promise<CategoryRow> {
    await this.access.assertSpaceAccessible(user, spaceId);
    if (input.parentId !== undefined && input.parentId !== null) {
      const parent = await this.db.query.kbCategories.findFirst({
        where: and(
          eq(kbCategories.id, input.parentId),
          eq(kbCategories.orgId, user.orgId),
          eq(kbCategories.spaceId, spaceId),
        ),
        columns: { id: true },
      });
      if (!parent) throw new BadRequestException("Parent collection not found in this space");
      const parentDepth = await this.depthOf(user.orgId, input.parentId);
      if (parentDepth + 1 >= KB_MAX_COLLECTION_DEPTH) {
        throw new BadRequestException(`Maximum collection depth of ${KB_MAX_COLLECTION_DEPTH} exceeded`);
      }
    }
    const slug = kbSlugify(input.name);
    if (!slug) throw new BadRequestException("Invalid name");
    const existing = await this.db.query.kbCategories.findFirst({
      where: and(
        eq(kbCategories.orgId, user.orgId),
        eq(kbCategories.spaceId, spaceId),
        eq(kbCategories.slug, slug),
      ),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A collection with this name already exists");
    const [category] = await this.db
      .insert(kbCategories)
      .values({
        orgId: user.orgId,
        spaceId,
        parentId: input.parentId ?? null,
        name: input.name,
        slug,
        description: input.description ?? null,
        icon: input.icon ?? null,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    return category;
  }

  async update(user: CurrentUserContext, categoryId: number, input: UpdateCategoryInput): Promise<CategoryRow> {
    const current = await this.db.query.kbCategories.findFirst({
      where: and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, user.orgId)),
      columns: { id: true, slug: true, spaceId: true },
    });
    if (!current) throw new NotFoundException("Collection not found");

    const values: Partial<typeof kbCategories.$inferInsert> = { updatedAt: new Date() };
    if (input.description !== undefined) values.description = input.description ?? null;
    if (input.icon !== undefined) values.icon = input.icon ?? null;
    if (input.sortOrder !== undefined) values.sortOrder = input.sortOrder;

    if (input.parentId !== undefined) {
      if (input.parentId === null) {
        values.parentId = null;
      } else {
        if (input.parentId === categoryId) {
          throw new BadRequestException("A collection cannot be its own parent");
        }
        const parent = await this.db.query.kbCategories.findFirst({
          where: and(
            eq(kbCategories.id, input.parentId),
            eq(kbCategories.orgId, user.orgId),
            eq(kbCategories.spaceId, current.spaceId ?? -1),
          ),
          columns: { id: true },
        });
        if (!parent) throw new BadRequestException("Parent collection not found in this space");
        if (await this.isAncestorOf(user.orgId, categoryId, input.parentId)) {
          throw new BadRequestException("Cannot move a collection under its own descendant");
        }
        const parentDepth = await this.depthOf(user.orgId, input.parentId);
        if (parentDepth + 1 >= KB_MAX_COLLECTION_DEPTH) {
          throw new BadRequestException(`Maximum collection depth of ${KB_MAX_COLLECTION_DEPTH} exceeded`);
        }
        values.parentId = input.parentId;
      }
    }

    if (input.name !== undefined) {
      const slug = kbSlugify(input.name);
      if (!slug) throw new BadRequestException("Invalid name");
      const clash = await this.db.query.kbCategories.findFirst({
        where: and(
          eq(kbCategories.orgId, user.orgId),
          eq(kbCategories.spaceId, current.spaceId ?? -1),
          eq(kbCategories.slug, slug),
          ne(kbCategories.id, categoryId),
        ),
        columns: { id: true },
      });
      if (clash) throw new ConflictException("A collection with this name already exists");
      values.name = input.name;
      values.slug = slug;
    }

    const [updated] = await this.db
      .update(kbCategories)
      .set(values)
      .where(and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, user.orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Collection not found");
    return updated;
  }

  async remove(orgId: string, categoryId: number): Promise<{ success: boolean }> {
    const [deleted] = await this.db
      .delete(kbCategories)
      .where(and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, orgId)))
      .returning({ id: kbCategories.id });
    if (!deleted) throw new NotFoundException("Collection not found");
    return { success: true };
  }

  private async depthOf(orgId: string, categoryId: number): Promise<number> {
    const rows = await this.db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth
        FROM kb_categories
        WHERE id = ${categoryId} AND org_id = ${orgId}
        UNION ALL
        SELECT c.id, c.parent_id, chain.depth + 1
        FROM kb_categories c
        INNER JOIN chain ON c.id = chain.parent_id
        WHERE c.org_id = ${orgId} AND chain.depth < ${KB_MAX_COLLECTION_DEPTH + 1}
      )
      SELECT COALESCE(MAX(depth), 0) AS depth FROM chain
    `);
    return Number(rows[0]?.depth ?? 0);
  }

  private async isAncestorOf(orgId: string, ancestorId: number, nodeId: number): Promise<boolean> {
    const rows = await this.db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth
        FROM kb_categories
        WHERE id = ${nodeId} AND org_id = ${orgId}
        UNION ALL
        SELECT c.id, c.parent_id, chain.depth + 1
        FROM kb_categories c
        INNER JOIN chain ON c.id = chain.parent_id
        WHERE c.org_id = ${orgId} AND chain.depth < ${KB_MAX_COLLECTION_DEPTH + 1}
      )
      SELECT 1 AS found FROM chain WHERE id = ${ancestorId} LIMIT 1
    `);
    return rows.length > 0;
  }
}
