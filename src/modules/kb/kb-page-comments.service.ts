import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { kbPageComments, kbPages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreatePageCommentInput, UpdatePageCommentInput } from "./dto/kb-page-comments.schemas";

type CommentRow = typeof kbPageComments.$inferSelect;

@Injectable()
export class KbPageCommentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, pageId: number): Promise<CommentRow[]> {
    await this.assertPageExists(orgId, pageId);
    return this.db
      .select()
      .from(kbPageComments)
      .where(and(eq(kbPageComments.orgId, orgId), eq(kbPageComments.pageId, pageId)))
      .orderBy(asc(kbPageComments.createdAt));
  }

  async create(orgId: string, pageId: number, authorId: string, input: CreatePageCommentInput): Promise<CommentRow> {
    await this.assertPageExists(orgId, pageId);

    if (input.parentId) {
      const parent = await this.db.query.kbPageComments.findFirst({
        where: and(
          eq(kbPageComments.id, input.parentId),
          eq(kbPageComments.orgId, orgId),
          eq(kbPageComments.pageId, pageId),
        ),
        columns: { id: true },
      });
      if (!parent) throw new NotFoundException("Parent comment not found");
    }

    const [comment] = await this.db
      .insert(kbPageComments)
      .values({
        orgId,
        pageId,
        authorId,
        content: input.content,
        parentId: input.parentId ?? null,
      })
      .returning();
    return comment;
  }

  async update(orgId: string, commentId: number, callerId: string, isAdmin: boolean, input: UpdatePageCommentInput): Promise<CommentRow> {
    const existing = await this.db.query.kbPageComments.findFirst({
      where: and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)),
      columns: { id: true, authorId: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");
    if (existing.authorId !== callerId && !isAdmin) throw new ForbiddenException("Not your comment");

    const [updated] = await this.db
      .update(kbPageComments)
      .set({ content: input.content, updatedAt: new Date() })
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)))
      .returning();
    return updated;
  }

  async remove(orgId: string, commentId: number, callerId: string, isAdmin: boolean): Promise<void> {
    const existing = await this.db.query.kbPageComments.findFirst({
      where: and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)),
      columns: { id: true, authorId: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");
    if (existing.authorId !== callerId && !isAdmin) throw new ForbiddenException("Not your comment");

    await this.db
      .delete(kbPageComments)
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)));
  }

  async resolve(orgId: string, commentId: number): Promise<CommentRow> {
    const [updated] = await this.db
      .update(kbPageComments)
      .set({ resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Comment not found");
    return updated;
  }

  private async assertPageExists(orgId: string, pageId: number): Promise<void> {
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!page) throw new NotFoundException("Page not found");
  }
}
