import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { kbArticleComments, kbArticles } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateCommentInput, UpdateCommentInput } from "./dto/kb-comments.schemas";

type CommentRow = typeof kbArticleComments.$inferSelect;

@Injectable()
export class KbCommentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, articleId: number): Promise<CommentRow[]> {
    return this.db
      .select()
      .from(kbArticleComments)
      .where(and(eq(kbArticleComments.orgId, orgId), eq(kbArticleComments.articleId, articleId)))
      .orderBy(asc(kbArticleComments.createdAt));
  }

  async create(orgId: string, articleId: number, authorId: string, input: CreateCommentInput): Promise<CommentRow> {
    const [article] = await this.db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)));

    if (!article) throw new NotFoundException("Article not found");

    const [comment] = await this.db
      .insert(kbArticleComments)
      .values({ orgId, articleId, authorId, content: input.content, parentId: input.parentId ?? null })
      .returning();

    return comment;
  }

  async update(orgId: string, commentId: number, authorId: string, input: UpdateCommentInput): Promise<CommentRow> {
    const [updated] = await this.db
      .update(kbArticleComments)
      .set({ content: input.content, updatedAt: new Date() })
      .where(
        and(
          eq(kbArticleComments.id, commentId),
          eq(kbArticleComments.orgId, orgId),
          eq(kbArticleComments.authorId, authorId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundException("Comment not found or you are not the author");

    return updated;
  }

  async remove(orgId: string, commentId: number, authorId: string): Promise<void> {
    const [deleted] = await this.db
      .delete(kbArticleComments)
      .where(
        and(
          eq(kbArticleComments.id, commentId),
          eq(kbArticleComments.orgId, orgId),
          eq(kbArticleComments.authorId, authorId),
        ),
      )
      .returning({ id: kbArticleComments.id });

    if (!deleted) throw new NotFoundException("Comment not found or you are not the author");
  }

  async resolve(orgId: string, commentId: number): Promise<CommentRow> {
    const [updated] = await this.db
      .update(kbArticleComments)
      .set({ resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(kbArticleComments.id, commentId), eq(kbArticleComments.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Comment not found");

    return updated;
  }
}
