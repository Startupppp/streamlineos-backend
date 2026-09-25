import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { kbPageComments, kbPages, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreatePageCommentInput, UpdatePageCommentInput } from "./dto/kb-page-comments.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { KeysetPosition } from "../../../common/pagination/keyset";
import { keysetAfterId } from "../../../common/pagination/keyset";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AccessService } from "../../access/access.service";

type CommentRow = typeof kbPageComments.$inferSelect;
type CommentWithAuthor = CommentRow & { authorName: string | null };

const PAGE_SIZE = 50;

@Injectable()
export class KbPageCommentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly access: AccessService,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async list(
    user: CurrentUserContext,
    pageId: number,
    cursor?: KeysetPosition,
  ): Promise<CommentWithAuthor[]> {
    const orgId = user.orgId;
    await this.assertPageExists(user, pageId);
    const conditions = [eq(kbPageComments.orgId, orgId), eq(kbPageComments.pageId, pageId)];
    if (cursor) conditions.push(keysetAfterId(kbPageComments.createdAt, kbPageComments.id, cursor));
    const rows = await this.db
      .select({
        comment: kbPageComments,
        authorName: users.name,
        authorEmail: users.email,
      })
      .from(kbPageComments)
      .leftJoin(users, eq(users.id, kbPageComments.authorId))
      .where(and(...conditions))
      .orderBy(asc(kbPageComments.createdAt), asc(kbPageComments.id))
      .limit(PAGE_SIZE);
    return rows.map(function toCommentWithAuthor(row) {
      return { ...row.comment, authorName: row.authorName ?? row.authorEmail };
    });
  }

  async create(user: CurrentUserContext, pageId: number, input: CreatePageCommentInput): Promise<CommentWithAuthor> {
    const orgId = user.orgId;
    const authorId = user.userId;
    const predicate = await this.auth.visiblePagePredicate(user, "comment");

    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, orgId),
        isNull(kbPages.deletedAt),
        predicate,
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
      await this.dispatch.emit({
        eventKey: "knowledge.page.comment_created",
        orgId,
        actorUserId: authorId,
        targetUserIds: Array.from(toNotify),
        entityType: "kb_page",
        entityId: String(pageId),
        title: "New comment on your page",
        message: input.content.slice(0, 200),
      });
    }

    return this.loadWithAuthor(orgId, comment.id);
  }

  async update(user: CurrentUserContext, commentId: number, input: UpdatePageCommentInput): Promise<CommentWithAuthor> {
    const orgId = user.orgId;
    const existing = await this.db.query.kbPageComments.findFirst({
      where: and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)),
      columns: { id: true, authorId: true, pageId: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");

    await this.assertCommentPageVisible(user, existing.pageId);

    const isAdmin = await this.access.holds(user, "kb:pages:manage");
    if (existing.authorId !== user.userId && !isAdmin) throw new ForbiddenException("Not your comment");

    const [updated] = await this.db
      .update(kbPageComments)
      .set({ content: input.content, updatedAt: new Date() })
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Comment not found");
    return this.loadWithAuthor(orgId, commentId);
  }

  async remove(user: CurrentUserContext, commentId: number): Promise<void> {
    const orgId = user.orgId;
    const existing = await this.db.query.kbPageComments.findFirst({
      where: and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)),
      columns: { id: true, authorId: true, pageId: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");

    await this.assertCommentPageVisible(user, existing.pageId);

    const isAdmin = await this.access.holds(user, "kb:pages:manage");
    if (existing.authorId !== user.userId && !isAdmin) throw new ForbiddenException("Not your comment");

    await this.db
      .delete(kbPageComments)
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)));
  }

  async resolve(user: CurrentUserContext, commentId: number): Promise<CommentWithAuthor> {
    const orgId = user.orgId;
    const existing = await this.db.query.kbPageComments.findFirst({
      where: and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)),
      columns: { id: true, pageId: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");

    await this.assertCommentPageVisible(user, existing.pageId);

    const [updated] = await this.db
      .update(kbPageComments)
      .set({ resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Comment not found");
    return this.loadWithAuthor(orgId, commentId);
  }

  private async loadWithAuthor(orgId: string, commentId: number): Promise<CommentWithAuthor> {
    const [row] = await this.db
      .select({ comment: kbPageComments, authorName: users.name, authorEmail: users.email })
      .from(kbPageComments)
      .leftJoin(users, eq(users.id, kbPageComments.authorId))
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)));
    if (!row) throw new NotFoundException("Comment not found");
    return { ...row.comment, authorName: row.authorName ?? row.authorEmail };
  }

  private async assertPageExists(user: CurrentUserContext, pageId: number): Promise<void> {
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
        predicate,
      ),
      columns: { id: true },
    });
    if (!page) throw new NotFoundException("Page not found");
  }

  private async assertCommentPageVisible(user: CurrentUserContext, pageId: number): Promise<void> {
    const predicate = await this.auth.visiblePagePredicate(user, "comment");
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
        predicate,
      ),
      columns: { id: true },
    });
    if (!page) throw new NotFoundException("Comment not found");
  }
}
