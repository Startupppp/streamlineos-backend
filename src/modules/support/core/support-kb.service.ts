import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
  kbCategories,
  kbArticles,
  kbArticleFeedback,
  kbArticleComments,
  kbArticleAttachments,
  users,
} from "../../../db/schema";
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
  CreateKbAttachmentInput,
  CreateKbCategoryInput,
  CreateKbCommentInput,
  ListKbArticlesInput,
  UpdateKbArticleInput,
  UpdateKbCategoryInput,
} from "./dto/support.schemas";

/**
 * Support KB categories, and the feedback / comments / attachments that hang
 * off an article. The article record itself, its slug and its tags live in
 * `lib/support-kb-articles.ts`; the five members below are thin delegates,
 * kept because `SupportKbController` injects this service.
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
     * No conflict handler under the insert, deliberately. The only unique a
     * caller could collide on, `uniq_kb_categories_org_space_slug` (org_id,
     * space_id, slug), is NULLS DISTINCT and this path never sets `space_id`,
     * so it cannot raise 23505 here — and the old handler read `e.code` off
     * Drizzle's wrapper besides. The check above is therefore the whole guard,
     * and it is a read followed by a write: two concurrent creates of the same
     * name both land. Closing that needs a partial unique on (org_id, slug)
     * WHERE space_id IS NULL, or NULLS NOT DISTINCT — a migration, not a catch.
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
      .set(values)
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

  updateArticle(orgId: string, articleId: number, input: UpdateKbArticleInput) {
    return updateArticle(this.db, orgId, articleId, input);
  }

  deleteArticle(orgId: string, articleId: number) {
    return deleteArticle(this.db, orgId, articleId);
  }

  async listFeedback(orgId: string, articleId: number) {
    await this.ensureArticle(orgId, articleId);
    return this.db
      .select({
        id: kbArticleFeedback.id,
        articleId: kbArticleFeedback.articleId,
        helpful: kbArticleFeedback.helpful,
        comment: kbArticleFeedback.comment,
        visitorId: kbArticleFeedback.visitorId,
        createdAt: kbArticleFeedback.createdAt,
      })
      .from(kbArticleFeedback)
      .where(and(eq(kbArticleFeedback.articleId, articleId), eq(kbArticleFeedback.orgId, orgId)))
      .orderBy(desc(kbArticleFeedback.createdAt))
      .limit(100);
  }

  async listComments(orgId: string, articleId: number) {
    await this.ensureArticle(orgId, articleId);
    return this.db
      .select({
        id: kbArticleComments.id,
        articleId: kbArticleComments.articleId,
        body: kbArticleComments.content,
        userId: kbArticleComments.authorId,
        userName: users.name,
        userImage: users.image,
        createdAt: kbArticleComments.createdAt,
        updatedAt: kbArticleComments.updatedAt,
      })
      .from(kbArticleComments)
      .leftJoin(users, eq(kbArticleComments.authorId, users.id))
      .where(and(eq(kbArticleComments.articleId, articleId), eq(kbArticleComments.orgId, orgId)))
      .orderBy(desc(kbArticleComments.createdAt))
      .limit(100);
  }

  async createComment(orgId: string, articleId: number, userId: string, input: CreateKbCommentInput) {
    await this.ensureArticle(orgId, articleId);

    const [inserted] = await this.db
      .insert(kbArticleComments)
      .values({ orgId, articleId, authorId: userId, content: input.body })
      .returning();

    const author = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, image: true },
    });

    return {
      id: inserted.id,
      articleId: inserted.articleId,
      body: inserted.content,
      userId: inserted.authorId,
      userName: author?.name ?? null,
      userImage: author?.image ?? null,
      createdAt: inserted.createdAt,
      updatedAt: inserted.updatedAt,
    };
  }

  async deleteComment(orgId: string, articleId: number, commentId: number) {
    const [deleted] = await this.db
      .delete(kbArticleComments)
      .where(
        and(
          eq(kbArticleComments.id, commentId),
          eq(kbArticleComments.articleId, articleId),
          eq(kbArticleComments.orgId, orgId),
        ),
      )
      .returning();

    if (!deleted) throw new NotFoundException("Comment not found");
    return { success: true };
  }

  async listAttachments(orgId: string, articleId: number) {
    await this.ensureArticle(orgId, articleId);
    return this.db
      .select({
        id: kbArticleAttachments.id,
        articleId: kbArticleAttachments.articleId,
        fileName: kbArticleAttachments.fileName,
        fileSize: kbArticleAttachments.fileSize,
        mimeType: kbArticleAttachments.mimeType,
        uploadedBy: kbArticleAttachments.uploadedBy,
        createdAt: kbArticleAttachments.createdAt,
      })
      .from(kbArticleAttachments)
      .where(
        and(eq(kbArticleAttachments.articleId, articleId), eq(kbArticleAttachments.orgId, orgId)),
      )
      .orderBy(desc(kbArticleAttachments.createdAt))
      .limit(100);
  }

  async createAttachment(orgId: string, articleId: number, userId: string, input: CreateKbAttachmentInput) {
    await this.ensureArticle(orgId, articleId);

    const [inserted] = await this.db
      .insert(kbArticleAttachments)
      .values({
        orgId,
        articleId,
        fileName: input.fileName,
        fileKey: input.fileKey,
        fileUrl: input.fileUrl ?? null,
        fileSize: input.fileSize,
        mimeType: input.mimeType,
        uploadedBy: userId,
      })
      .returning({
        id: kbArticleAttachments.id,
        articleId: kbArticleAttachments.articleId,
        fileName: kbArticleAttachments.fileName,
        fileSize: kbArticleAttachments.fileSize,
        mimeType: kbArticleAttachments.mimeType,
        uploadedBy: kbArticleAttachments.uploadedBy,
        createdAt: kbArticleAttachments.createdAt,
      });

    return inserted;
  }

  async deleteAttachment(orgId: string, articleId: number, attachmentId: number) {
    const [deleted] = await this.db
      .delete(kbArticleAttachments)
      .where(
        and(
          eq(kbArticleAttachments.id, attachmentId),
          eq(kbArticleAttachments.articleId, articleId),
          eq(kbArticleAttachments.orgId, orgId),
        ),
      )
      .returning({ fileKey: kbArticleAttachments.fileKey });

    if (!deleted) throw new NotFoundException("Attachment not found");
    return { success: true };
  }

  private async ensureArticle(orgId: string, articleId: number) {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");
  }
}
