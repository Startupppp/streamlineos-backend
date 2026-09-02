import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  kbArticleAttachments,
  kbArticleComments,
  kbArticleFeedback,
  kbArticles,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StorageService } from "../../storage/storage.service";
import type {
  CreateKbAttachmentInput,
  CreateKbCommentInput,
} from "./dto/support.schemas";

const ATTACHMENT_DOWNLOAD_EXPIRY_SECONDS = 3600;

@Injectable()
export class SupportKbEngagementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  private async ensureArticle(orgId: string, articleId: number) {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");
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

  async getAttachmentDownloadUrl(orgId: string, articleId: number, attachmentId: number) {
    const [row] = await this.db
      .select({
        fileKey: kbArticleAttachments.fileKey,
        fileName: kbArticleAttachments.fileName,
        mimeType: kbArticleAttachments.mimeType,
      })
      .from(kbArticleAttachments)
      .where(
        and(
          eq(kbArticleAttachments.id, attachmentId),
          eq(kbArticleAttachments.articleId, articleId),
          eq(kbArticleAttachments.orgId, orgId),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Attachment not found");

    const downloadUrl = await this.storage.getFileUrl(orgId, row.fileKey, ATTACHMENT_DOWNLOAD_EXPIRY_SECONDS);
    return { fileName: row.fileName, mimeType: row.mimeType, downloadUrl };
  }
}
