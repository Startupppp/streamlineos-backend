import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, ne } from "drizzle-orm";
import { kbCategories } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  createArticle,
  deleteArticle,
  getArticle,
  listArticles,
  slugify,
  updateArticle,
} from "./lib/support-kb-articles";
import type {
  CreateKbArticleInput,
  CreateKbCategoryInput,
  ListKbArticlesInput,
  UpdateKbArticleInput,
  UpdateKbCategoryInput,
} from "./dto/support.schemas";

/**
 * Support KB categories. The article record itself, its slug, its tags and its
 * version history live in `lib/support-kb-articles.ts`; the five members below
 * are thin delegates, kept because `SupportKbController` injects this service.
 * Feedback, comments and attachments hang off an article they do not own and
 * live in `SupportKbEngagementService`.
 */
@Injectable()
export class SupportKbService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  listCategories(orgId: string) {
    return this.db.query.kbCategories.findMany({
      where: eq(kbCategories.orgId, orgId),
      orderBy: [asc(kbCategories.sortOrder), asc(kbCategories.name)],
      limit: 100,
    });
  }

  async createCategory(orgId: string, input: CreateKbCategoryInput) {
    const slug = slugify(input.name);
    if (!slug) throw new BadRequestException("Invalid name");

    const existing = await this.db.query.kbCategories.findFirst({
      where: and(eq(kbCategories.orgId, orgId), eq(kbCategories.slug, slug)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A category with this name already exists");

    /**
     * No conflict handler under the insert, deliberately.
     *
     * `uniq_kb_categories_org_space_slug` is (org_id, space_id, slug) and is
     * NULLS DISTINCT — migration 0000 creates it with no `NULLS NOT DISTINCT`
     * — while this path never sets `space_id`. Two rows with the same slug and
     * a null space therefore do NOT collide, so the index cannot raise 23505
     * here at all; the only other unique on the table is (org_id, id) over a
     * serial nobody supplies. The handler that used to sit here was dead twice
     * over: it read `e.code` off a value Drizzle keeps the SQLSTATE under, and
     * there was no violation for it to read.
     *
     * The check above is therefore the whole guard, and it is a read followed
     * by a write. Two concurrent creates of the same name both pass it and
     * both land, which no index will refuse. Closing that needs a partial
     * unique on (org_id, slug) WHERE space_id IS NULL, or NULLS NOT DISTINCT —
     * a migration, not a catch block, and out of scope here. Recorded rather
     * than papered over with a branch that cannot fire.
     */
    const [category] = await this.db
      .insert(kbCategories)
      .values({
        orgId,
        name: input.name,
        slug,
        description: input.description ?? null,
        icon: input.icon ?? null,
        sortOrder: input.sortOrder ?? 0,
        isPublished: input.isPublished ?? false,
      })
      .returning();
    return category;
  }

  async updateCategory(orgId: string, categoryId: number, input: UpdateKbCategoryInput) {
    const values: Partial<typeof kbCategories.$inferInsert> = {
      description: input.description,
      icon: input.icon,
      sortOrder: input.sortOrder,
      isPublished: input.isPublished,
    };
    if (input.name !== undefined) {
      const slug = slugify(input.name);
      if (!slug) throw new BadRequestException("Invalid name");
      const clash = await this.db.query.kbCategories.findFirst({
        where: and(
          eq(kbCategories.orgId, orgId),
          eq(kbCategories.slug, slug),
          ne(kbCategories.id, categoryId),
        ),
        columns: { id: true },
      });
      if (clash) throw new ConflictException("A category with this name already exists");
      values.name = input.name;
      values.slug = slug;
    }

    const [updated] = await this.db
      .update(kbCategories)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Category not found");
    return updated;
  }

  async deleteCategory(orgId: string, categoryId: number) {
    const [deleted] = await this.db
      .delete(kbCategories)
      .where(and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Category not found");
    return { success: true };
  }

  listArticles(orgId: string, query: ListKbArticlesInput) {
    return listArticles(this.db, orgId, query);
  }

  createArticle(orgId: string, userId: string, input: CreateKbArticleInput) {
    return createArticle(this.db, orgId, userId, input);
  }

  getArticle(orgId: string, articleId: number) {
    return getArticle(this.db, orgId, articleId);
  }

  updateArticle(orgId: string, articleId: number, input: UpdateKbArticleInput, authorId: string | null = null) {
    return updateArticle(this.db, orgId, articleId, input, authorId);
  }

  deleteArticle(orgId: string, articleId: number) {
    return deleteArticle(this.db, orgId, articleId);
  }
}
