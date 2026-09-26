import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, ne } from "drizzle-orm";
import { kbCategories } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbPageWriterService } from "../../kb/wiki/kb-page-writer.service";
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

@Injectable()
export class SupportKbService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly writer: KbPageWriterService,
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
    if (existing)
      throw new ConflictException("A category with this name already exists");

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

  async updateCategory(
    orgId: string,
    categoryId: number,
    input: UpdateKbCategoryInput,
  ) {
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
      if (clash)
        throw new ConflictException("A category with this name already exists");
      values.name = input.name;
      values.slug = slug;
    }

    const [updated] = await this.db
      .update(kbCategories)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, orgId)),
      )
      .returning();

    if (!updated) throw new NotFoundException("Category not found");
    return updated;
  }

  async deleteCategory(orgId: string, categoryId: number) {
    const [deleted] = await this.db
      .delete(kbCategories)
      .where(
        and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, orgId)),
      )
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

  updateArticle(
    orgId: string,
    articleId: number,
    input: UpdateKbArticleInput,
    authorId: string | null = null,
  ) {
    return updateArticle(
      this.db,
      this.writer,
      orgId,
      articleId,
      input,
      authorId,
    );
  }

  deleteArticle(orgId: string, articleId: number) {
    return deleteArticle(this.db, orgId, articleId);
  }
}
