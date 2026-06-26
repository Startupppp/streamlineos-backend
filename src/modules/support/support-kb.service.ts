import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, ilike, ne, or, type SQL } from "drizzle-orm";
import {
  kbCategories,
  kbArticles,
  kbArticleFeedback,
  kbArticleComments,
  kbArticleAttachments,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateKbArticleInput,
  CreateKbAttachmentInput,
  CreateKbCategoryInput,
  CreateKbCommentInput,
  ListKbArticlesInput,
  UpdateKbArticleInput,
  UpdateKbCategoryInput,
} from "./dto/support.schemas";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

@Injectable()
export class SupportKbService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listCategories(orgId: string) {
    return this.db.query.kbCategories.findMany({
      where: eq(kbCategories.orgId, orgId),
      orderBy: [asc(kbCategories.sortOrder), asc(kbCategories.name)],
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
    const conditions: SQL[] = [eq(kbArticles.orgId, orgId)];
    if (query.status) conditions.push(eq(kbArticles.status, query.status));
    if (query.visibility) conditions.push(eq(kbArticles.visibility, query.visibility));
    if (query.categoryId) conditions.push(eq(kbArticles.categoryId, query.categoryId));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(kbArticles.title, term), ilike(kbArticles.excerpt, term));
      if (match) conditions.push(match);
    }

    return this.db
      .select({
        id: kbArticles.id,
        orgId: kbArticles.orgId,
        categoryId: kbArticles.categoryId,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        status: kbArticles.status,
        visibility: kbArticles.visibility,
        authorId: kbArticles.authorId,
        views: kbArticles.views,
        helpfulCount: kbArticles.helpfulCount,
        notHelpfulCount: kbArticles.notHelpfulCount,
        tags: kbArticles.tags,
        publishedAt: kbArticles.publishedAt,
        createdAt: kbArticles.createdAt,
        updatedAt: kbArticles.updatedAt,
      })
      .from(kbArticles)
      .where(and(...conditions))
      .orderBy(desc(kbArticles.updatedAt));
  }

  async createArticle(orgId: string, userId: string, input: CreateKbArticleInput) {
    const slug = await this.uniqueArticleSlug(orgId, input.title);

    const [article] = await this.db
      .insert(kbArticles)
      .values({
        orgId,
        categoryId: input.categoryId ?? null,
        title: input.title,
        slug,
        excerpt: input.excerpt ?? null,
        content: input.content ?? "",
        status: input.status,
        visibility: input.visibility,
        authorId: userId,
        tags: input.tags ?? null,
        publishedAt: input.status === "published" ? new Date() : null,
      })
      .returning();
    return article;
  }

  async getArticle(orgId: string, articleId: number) {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      with: { category: { columns: { id: true, name: true, slug: true } } },
    });
    if (!article) throw new NotFoundException("Article not found");
    return article;
  }

  async updateArticle(orgId: string, articleId: number, input: UpdateKbArticleInput) {
    const current = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { id: true, slug: true, status: true, publishedAt: true },
    });
    if (!current) throw new NotFoundException("Article not found");

    const values: Partial<typeof kbArticles.$inferInsert> = {
      categoryId: input.categoryId,
      excerpt: input.excerpt,
      content: input.content,
      visibility: input.visibility,
      tags: input.tags,
    };

    if (input.title !== undefined) {
      values.title = input.title;
      const slug = slugify(input.title);
      if (slug && slug !== current.slug) {
        const clash = await this.db.query.kbArticles.findFirst({
          where: and(
            eq(kbArticles.orgId, orgId),
            eq(kbArticles.slug, slug),
            ne(kbArticles.id, articleId),
          ),
          columns: { id: true },
        });
        if (!clash) values.slug = slug;
      }
    }

    if (input.status !== undefined) {
      values.status = input.status;
      if (input.status === "published" && !current.publishedAt) {
        values.publishedAt = new Date();
      }
    }

    const [updated] = await this.db
      .update(kbArticles)
      .set(values)
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Article not found");
    return updated;
  }

  async deleteArticle(orgId: string, articleId: number) {
    const [deleted] = await this.db
      .delete(kbArticles)
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Article not found");
    return { success: true };
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
      .orderBy(desc(kbArticleFeedback.createdAt));
  }

  async listComments(orgId: string, articleId: number) {
    await this.ensureArticle(orgId, articleId);
    return this.db
      .select({
        id: kbArticleComments.id,
        articleId: kbArticleComments.articleId,
        body: kbArticleComments.body,
        userId: kbArticleComments.userId,
        userName: users.name,
        userImage: users.image,
        createdAt: kbArticleComments.createdAt,
        updatedAt: kbArticleComments.updatedAt,
      })
      .from(kbArticleComments)
      .leftJoin(users, eq(kbArticleComments.userId, users.id))
      .where(and(eq(kbArticleComments.articleId, articleId), eq(kbArticleComments.orgId, orgId)))
      .orderBy(desc(kbArticleComments.createdAt));
  }

  async createComment(orgId: string, articleId: number, userId: string, input: CreateKbCommentInput) {
    await this.ensureArticle(orgId, articleId);

    const [inserted] = await this.db
      .insert(kbArticleComments)
      .values({ orgId, articleId, userId, body: input.body })
      .returning();

    const author = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, image: true },
    });

    return {
      id: inserted.id,
      articleId: inserted.articleId,
      body: inserted.body,
      userId: inserted.userId,
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
      .orderBy(desc(kbArticleAttachments.createdAt));
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

  private async uniqueArticleSlug(orgId: string, base: string): Promise<string> {
    const root = slugify(base) || "article";
    let slug = root;
    let suffix = 1;
    while (true) {
      const existing = await this.db.query.kbArticles.findFirst({
        where: and(eq(kbArticles.orgId, orgId), eq(kbArticles.slug, slug)),
        columns: { id: true },
      });
      if (!existing) return slug;
      suffix += 1;
      slug = `${root}-${suffix}`;
    }
  }
}
