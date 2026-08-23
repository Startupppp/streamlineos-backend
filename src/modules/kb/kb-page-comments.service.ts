import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { kbPageComments, kbPages, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreatePageCommentInput, UpdatePageCommentInput } from "./dto/kb-page-comments.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { pageVisibleTo } from "./kb-page-visibility";
import { getAccessibleProjectIds } from "./kb-project-access.util";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

type CommentRow = typeof kbPageComments.$inferSelect;

@Injectable()
export class KbPageCommentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async list(user: CurrentUserContext, pageId: number): Promise<Array<CommentRow & { authorName: string | null }>> {
    const orgId = user.orgId;
    await this.assertPageExists(user, pageId);
    const rows = await this.db
      .select({
        comment: kbPageComments,
        authorName: users.name,
        authorEmail: users.email,
      })
      .from(kbPageComments)
      .leftJoin(users, eq(users.id, kbPageComments.authorId))
      .where(and(eq(kbPageComments.orgId, orgId), eq(kbPageComments.pageId, pageId)))
      .orderBy(asc(kbPageComments.createdAt));
    return rows.map(function toCommentWithAuthor(row) {
      return { ...row.comment, authorName: row.authorName ?? row.authorEmail };
    });
  }

  async create(user: CurrentUserContext, pageId: number, input: CreatePageCommentInput): Promise<CommentRow> {
    const orgId = user.orgId;
    const authorId = user.userId;
    const projectIds = await getAccessibleProjectIds(this.db, user);

    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, orgId),
        isNull(kbPages.deletedAt),
        pageVisibleTo(user, projectIds),
      ),
      columns: { id: true, createdById: true, ownerUserId: true },
    });
    if (!page) throw new NotFoundException("Page not found");

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
      .values({ orgId, pageId, authorId, content: input.content, parentId: input.parentId ?? null })
      .returning();
    if (!comment) throw new Error("Failed to create comment");

    const toNotify = new Set<string>();
    if (page.createdById && page.createdById !== authorId) toNotify.add(page.createdById);
    if (page.ownerUserId && page.ownerUserId !== authorId) toNotify.add(page.ownerUserId);

    if (toNotify.size > 0) {
      void this.dispatch
        .emit({
          eventKey: "knowledge.page.comment_created",
          orgId,
          actorUserId: authorId,
          targetUserIds: Array.from(toNotify),
          entityType: "kb_page",
          entityId: String(pageId),
          title: "New comment on your page",
          message: input.content.slice(0, 200),
        })
        .catch(function notifError(err: unknown) {
          console.error("Failed to send comment notification", err);
        });
    }

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
    const existing = await this.db.query.kbPageComments.findFirst({
      where: and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");

    const [updated] = await this.db
      .update(kbPageComments)
      .set({ resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Comment not found");
    return updated;
  }

  private async assertPageExists(user: CurrentUserContext, pageId: number): Promise<void> {
    const projectIds = await getAccessibleProjectIds(this.db, user);
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
        pageVisibleTo(user, projectIds),
      ),
      columns: { id: true },
    });
    if (!page) throw new NotFoundException("Page not found");
  }
}
