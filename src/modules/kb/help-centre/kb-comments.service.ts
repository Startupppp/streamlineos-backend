import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { kbPageComments, kbPages, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateCommentInput, UpdateCommentInput } from "./dto/kb-comments.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { KeysetPosition } from "../../../common/pagination/keyset";
import { keysetAfterId } from "../../../common/pagination/keyset";
import { KbAccessService } from "../core/kb-access.service";
import { AccessService } from "../../access/access.service";
import { supportArticlePredicate } from "./kb-article-page-scope";
import type { kbArticleCommentWithAuthorSchema } from "./dto/kb-helpcenter-response.schemas";

const PAGE_SIZE = 50;

type CommentWithAuthor = z.infer<typeof kbArticleCommentWithAuthorSchema>;

type CommentOwner = { id: number; authorId: string | null; articleId: number };

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
      eq(kbPageComments.orgId, user.orgId),
      eq(kbPageComments.pageId, articleId),
      supportArticlePredicate(),
    ];
    if (cursor) conditions.push(keysetAfterId(kbPageComments.createdAt, kbPageComments.id, cursor));
    const rows = await this.db
      .select({
        id: kbPageComments.id,
        orgId: kbPageComments.orgId,
        articleId: kbPageComments.pageId,
        authorId: kbPageComments.authorId,
        content: kbPageComments.content,
        parentId: kbPageComments.parentId,
        resolvedAt: kbPageComments.resolvedAt,
        createdAt: kbPageComments.createdAt,
        updatedAt: kbPageComments.updatedAt,
        authorName: users.name,
      })
      .from(kbPageComments)
      .innerJoin(
        kbPages,
        and(eq(kbPages.orgId, kbPageComments.orgId), eq(kbPages.id, kbPageComments.pageId)),
      )
      .leftJoin(users, eq(users.id, kbPageComments.authorId))
      .where(and(...conditions))
      .orderBy(asc(kbPageComments.createdAt), asc(kbPageComments.id))
      .limit(PAGE_SIZE);
    return rows;
  }

  async create(user: CurrentUserContext, articleId: number, input: CreateCommentInput): Promise<CommentWithAuthor> {
    await this.kbAccess.assertArticleViewable(user, articleId);

    if (input.parentId) {
      const [parent] = await this.db
        .select({ id: kbPageComments.id })
        .from(kbPageComments)
        .where(
          and(
            eq(kbPageComments.id, input.parentId),
            eq(kbPageComments.orgId, user.orgId),
            eq(kbPageComments.pageId, articleId),
          ),
        )
        .limit(1);
      if (!parent) throw new NotFoundException("Parent comment not found");
    }

    const [comment] = await this.db
      .insert(kbPageComments)
      .values({ orgId: user.orgId, pageId: articleId, authorId: user.userId, content: input.content, parentId: input.parentId ?? null })
      .returning({ id: kbPageComments.id });
    if (!comment) throw new Error("Failed to create comment");
    return this.loadWithAuthor(user.orgId, comment.id);
  }

  async update(user: CurrentUserContext, commentId: number, input: UpdateCommentInput): Promise<CommentWithAuthor> {
    const existing = await this.loadArticleComment(user.orgId, commentId);

    await this.kbAccess.assertArticleViewable(user, existing.articleId);
    await this.assertMayModerate(user, existing);

    const [updated] = await this.db
      .update(kbPageComments)
      .set({ content: input.content, updatedAt: new Date() })
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, user.orgId)))
      .returning({ id: kbPageComments.id });
    if (!updated) throw new NotFoundException("Comment not found");
    return this.loadWithAuthor(user.orgId, commentId);
  }

  async remove(user: CurrentUserContext, commentId: number): Promise<void> {
    const existing = await this.loadArticleComment(user.orgId, commentId);

    await this.kbAccess.assertArticleViewable(user, existing.articleId);
    await this.assertMayModerate(user, existing);

    await this.db
      .delete(kbPageComments)
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, user.orgId)));
  }

  async resolve(user: CurrentUserContext, commentId: number): Promise<CommentWithAuthor> {
    const existing = await this.loadArticleComment(user.orgId, commentId);

    await this.kbAccess.assertArticleEditable(user, existing.articleId);

    const [updated] = await this.db
      .update(kbPageComments)
      .set({ resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, user.orgId)))
      .returning({ id: kbPageComments.id });
    if (!updated) throw new NotFoundException("Comment not found");
    return this.loadWithAuthor(user.orgId, commentId);
  }

  private async assertMayModerate(user: CurrentUserContext, comment: CommentOwner): Promise<void> {
    if (comment.authorId === user.userId) return;
    const isAdmin = await this.access.holds(user, "kb:spaces:manage");
    if (!isAdmin) throw new ForbiddenException("Not your comment");
  }

  private async loadArticleComment(orgId: string, commentId: number): Promise<CommentOwner> {
    const [row] = await this.db
      .select({
        id: kbPageComments.id,
        authorId: kbPageComments.authorId,
        articleId: kbPageComments.pageId,
      })
      .from(kbPageComments)
      .innerJoin(
        kbPages,
        and(eq(kbPages.orgId, kbPageComments.orgId), eq(kbPages.id, kbPageComments.pageId)),
      )
      .where(
        and(
          eq(kbPageComments.id, commentId),
          eq(kbPageComments.orgId, orgId),
          supportArticlePredicate(),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Comment not found");
    return row;
  }

  private async loadWithAuthor(orgId: string, commentId: number): Promise<CommentWithAuthor> {
    const [row] = await this.db
      .select({
        id: kbPageComments.id,
        orgId: kbPageComments.orgId,
        articleId: kbPageComments.pageId,
        authorId: kbPageComments.authorId,
        content: kbPageComments.content,
        parentId: kbPageComments.parentId,
        resolvedAt: kbPageComments.resolvedAt,
        createdAt: kbPageComments.createdAt,
        updatedAt: kbPageComments.updatedAt,
        authorName: users.name,
      })
      .from(kbPageComments)
      .leftJoin(users, eq(users.id, kbPageComments.authorId))
      .where(and(eq(kbPageComments.id, commentId), eq(kbPageComments.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Comment not found");
    return row;
  }
}
