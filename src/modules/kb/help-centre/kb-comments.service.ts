import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { kbArticleComments, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateCommentInput, UpdateCommentInput } from "./dto/kb-comments.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { KeysetPosition } from "../../../common/pagination/keyset";
import { keysetAfterId } from "../../../common/pagination/keyset";
import { KbAccessService } from "../core/kb-access.service";
import { AccessService } from "../../access/access.service";

const PAGE_SIZE = 50;

type CommentRow = typeof kbArticleComments.$inferSelect;
type CommentWithAuthor = CommentRow & { authorName: string | null };

@Injectable()
export class KbCommentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly kbAccess: KbAccessService,
    private readonly access: AccessService,
  ) {}

  async list(user: CurrentUserContext, articleId: number, cursor?: KeysetPosition): Promise<CommentWithAuthor[]> {
    await this.kbAccess.assertArticleViewable(user, articleId);
    const conditions = [
      eq(kbArticleComments.orgId, user.orgId),
      eq(kbArticleComments.articleId, articleId),
    ];
    if (cursor) conditions.push(keysetAfterId(kbArticleComments.createdAt, kbArticleComments.id, cursor));
    const rows = await this.db
      .select({
        id: kbArticleComments.id,
        orgId: kbArticleComments.orgId,
        articleId: kbArticleComments.articleId,
        authorId: kbArticleComments.authorId,
        content: kbArticleComments.content,
        parentId: kbArticleComments.parentId,
        resolvedAt: kbArticleComments.resolvedAt,
        createdAt: kbArticleComments.createdAt,
        updatedAt: kbArticleComments.updatedAt,
        authorName: users.name,
      })
      .from(kbArticleComments)
      .leftJoin(users, eq(users.id, kbArticleComments.authorId))
      .where(and(...conditions))
      .orderBy(asc(kbArticleComments.createdAt), asc(kbArticleComments.id))
      .limit(PAGE_SIZE);
    return rows.map(function toCommentWithAuthor(row): CommentWithAuthor {
      const { authorName, ...comment } = row;
      return { ...comment, authorName };
    });
  }

  async create(user: CurrentUserContext, articleId: number, input: CreateCommentInput): Promise<CommentWithAuthor> {
    await this.kbAccess.assertArticleViewable(user, articleId);

    if (input.parentId) {
      const parent = await this.db.query.kbArticleComments.findFirst({
        where: and(
          eq(kbArticleComments.id, input.parentId),
          eq(kbArticleComments.orgId, user.orgId),
          eq(kbArticleComments.articleId, articleId),
        ),
        columns: { id: true },
      });
      if (!parent) throw new NotFoundException("Parent comment not found");
    }

    const [comment] = await this.db
      .insert(kbArticleComments)
      .values({ orgId: user.orgId, articleId, authorId: user.userId, content: input.content, parentId: input.parentId ?? null })
      .returning();
    if (!comment) throw new Error("Failed to create comment");
    return this.loadWithAuthor(user.orgId, comment.id);
  }

  async update(user: CurrentUserContext, commentId: number, input: UpdateCommentInput): Promise<CommentWithAuthor> {
    const existing = await this.db.query.kbArticleComments.findFirst({
      where: and(eq(kbArticleComments.id, commentId), eq(kbArticleComments.orgId, user.orgId)),
      columns: { id: true, authorId: true, articleId: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");

    await this.kbAccess.assertArticleViewable(user, existing.articleId);

    const isAdmin = await this.access.holds(user, "kb:spaces:manage");
    if (existing.authorId !== user.userId && !isAdmin) throw new ForbiddenException("Not your comment");

    const [updated] = await this.db
      .update(kbArticleComments)
      .set({ content: input.content, updatedAt: new Date() })
      .where(and(eq(kbArticleComments.id, commentId), eq(kbArticleComments.orgId, user.orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Comment not found");
    return this.loadWithAuthor(user.orgId, commentId);
  }

  async remove(user: CurrentUserContext, commentId: number): Promise<void> {
    const existing = await this.db.query.kbArticleComments.findFirst({
      where: and(eq(kbArticleComments.id, commentId), eq(kbArticleComments.orgId, user.orgId)),
      columns: { id: true, authorId: true, articleId: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");

    await this.kbAccess.assertArticleViewable(user, existing.articleId);

    const isAdmin = await this.access.holds(user, "kb:spaces:manage");
    if (existing.authorId !== user.userId && !isAdmin) throw new ForbiddenException("Not your comment");

    await this.db
      .delete(kbArticleComments)
      .where(and(eq(kbArticleComments.id, commentId), eq(kbArticleComments.orgId, user.orgId)));
  }

  async resolve(user: CurrentUserContext, commentId: number): Promise<CommentWithAuthor> {
    const existing = await this.db.query.kbArticleComments.findFirst({
      where: and(eq(kbArticleComments.id, commentId), eq(kbArticleComments.orgId, user.orgId)),
      columns: { id: true, articleId: true },
    });
    if (!existing) throw new NotFoundException("Comment not found");

    await this.kbAccess.assertArticleEditable(user, existing.articleId);

    const [updated] = await this.db
      .update(kbArticleComments)
      .set({ resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(kbArticleComments.id, commentId), eq(kbArticleComments.orgId, user.orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Comment not found");
    return this.loadWithAuthor(user.orgId, commentId);
  }

  private async loadWithAuthor(orgId: string, commentId: number): Promise<CommentWithAuthor> {
    const [row] = await this.db
      .select({ comment: kbArticleComments, authorName: users.name })
      .from(kbArticleComments)
      .leftJoin(users, eq(users.id, kbArticleComments.authorId))
      .where(and(eq(kbArticleComments.id, commentId), eq(kbArticleComments.orgId, orgId)));
    if (!row) throw new NotFoundException("Comment not found");
    return { ...row.comment, authorName: row.authorName };
  }
}
