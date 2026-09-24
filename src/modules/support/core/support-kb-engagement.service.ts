import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  kbPageAttachments,
  kbPageComments,
  kbPageFeedback,
  kbPages,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { storagePendingPurge } from "../../../db/schema/common/storage-pending-purge";
import { supportArticlePredicate } from "../../kb/help-centre/kb-article-page-scope";
import { isOwnOrgStorageKey } from "../../storage/storage-key";
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
    const article = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
        isNull(kbPages.archivedAt),
      ),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");
  }

  async listFeedback(orgId: string, articleId: number) {
    await this.ensureArticle(orgId, articleId);
    return this.db
      .select({
        id: kbPageFeedback.id,
        articleId: kbPageFeedback.pageId,
        helpful: kbPageFeedback.helpful,
        comment: kbPageFeedback.comment,
        visitorId: kbPageFeedback.visitorId,
        createdAt: kbPageFeedback.createdAt,
      })
      .from(kbPageFeedback)
      .where(and(eq(kbPageFeedback.pageId, articleId), eq(kbPageFeedback.orgId, orgId)))
      .orderBy(desc(kbPageFeedback.createdAt))
      .limit(100);
  }

  async listComments(orgId: string, articleId: number) {
    await this.ensureArticle(orgId, articleId);
    return this.db
      .select({
        id: kbPageComments.id,
        articleId: kbPageComments.pageId,
        body: kbPageComments.content,
        userId: kbPageComments.authorId,
        userName: users.name,
        userImage: users.image,
        createdAt: kbPageComments.createdAt,
        updatedAt: kbPageComments.updatedAt,
      })
      .from(kbPageComments)
      .leftJoin(users, and(eq(kbPageComments.authorId, users.id), isNull(users.deletedAt)))
      .where(and(eq(kbPageComments.pageId, articleId), eq(kbPageComments.orgId, orgId)))
      .orderBy(desc(kbPageComments.createdAt))
      .limit(100);
  }

  async createComment(orgId: string, articleId: number, userId: string, input: CreateKbCommentInput) {
    await this.ensureArticle(orgId, articleId);

    const [inserted] = await this.db
      .insert(kbPageComments)
      .values({ orgId, pageId: articleId, authorId: userId, content: input.body })
      .returning({
        id: kbPageComments.id,
        articleId: kbPageComments.pageId,
        body: kbPageComments.content,
        userId: kbPageComments.authorId,
        createdAt: kbPageComments.createdAt,
        updatedAt: kbPageComments.updatedAt,
      });

    const author = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, image: true },
    });

    return {
      ...inserted,
      userName: author?.name ?? null,
      userImage: author?.image ?? null,
    };
  }

  async deleteComment(orgId: string, articleId: number, commentId: number) {
    const [deleted] = await this.db
      .delete(kbPageComments)
      .where(
        and(
          eq(kbPageComments.id, commentId),
          eq(kbPageComments.pageId, articleId),
          eq(kbPageComments.orgId, orgId),
        ),
      )
      .returning({ id: kbPageComments.id });

    if (!deleted) throw new NotFoundException("Comment not found");
    return { success: true };
  }

  async listAttachments(orgId: string, articleId: number) {
    await this.ensureArticle(orgId, articleId);
    return this.db
      .select({
        id: kbPageAttachments.id,
        articleId: kbPageAttachments.pageId,
        fileName: kbPageAttachments.fileName,
        fileSize: kbPageAttachments.fileSize,
        mimeType: kbPageAttachments.mimeType,
        uploadedBy: kbPageAttachments.uploadedById,
        createdAt: kbPageAttachments.createdAt,
      })
      .from(kbPageAttachments)
      .where(
        and(
          eq(kbPageAttachments.pageId, articleId),
          eq(kbPageAttachments.orgId, orgId),
          isNull(kbPageAttachments.deletedAt),
        ),
      )
      .orderBy(desc(kbPageAttachments.createdAt))
      .limit(100);
  }

  async createAttachment(orgId: string, articleId: number, userId: string, input: CreateKbAttachmentInput) {
    await this.ensureArticle(orgId, articleId);

    /**
     * The bytes never pass through this route, so the only thing standing
     * between a client string and a stored pointer is this assertion.
     */
    if (!isOwnOrgStorageKey(input.fileKey, orgId))
      throw new BadRequestException("Invalid file reference");

    const [inserted] = await this.db
      .insert(kbPageAttachments)
      .values({
        orgId,
        pageId: articleId,
        fileName: input.fileName,
        fileKey: input.fileKey,
        fileUrl: input.fileUrl ?? null,
        fileSize: input.fileSize,
        mimeType: input.mimeType,
        uploadedById: userId,
      })
      .returning({
        id: kbPageAttachments.id,
        articleId: kbPageAttachments.pageId,
        fileName: kbPageAttachments.fileName,
        fileSize: kbPageAttachments.fileSize,
        mimeType: kbPageAttachments.mimeType,
        uploadedBy: kbPageAttachments.uploadedById,
        createdAt: kbPageAttachments.createdAt,
      });

    return inserted;
  }

  async deleteAttachment(orgId: string, articleId: number, attachmentId: number) {
    const [deleted] = await this.db
      .delete(kbPageAttachments)
      .where(
        and(
          eq(kbPageAttachments.id, attachmentId),
          eq(kbPageAttachments.pageId, articleId),
          eq(kbPageAttachments.orgId, orgId),
          isNull(kbPageAttachments.deletedAt),
        ),
      )
      .returning({ fileKey: kbPageAttachments.fileKey });

    if (!deleted) throw new NotFoundException("Attachment not found");

    /**
     * The row is gone; without this the object it pointed at is unreachable and
     * unbilled-for forever. The sweeper retries the delete, so a storage outage
     * is a delay rather than a permanent orphan.
     */
    if (deleted.fileKey.trim().length > 0) {
      await this.db
        .insert(storagePendingPurge)
        .values({
          orgId,
          storageKey: deleted.fileKey,
          purpose: "support:kb-attachment:delete",
          bucket: "default",
          status: "pending",
        })
        .onConflictDoUpdate({
          target: [storagePendingPurge.orgId, storagePendingPurge.storageKey],
          set: { status: "pending", lastAttemptedAt: null, failedReason: null },
        });
    }

    return { success: true };
  }

  async getAttachmentDownloadUrl(orgId: string, articleId: number, attachmentId: number) {
    const [row] = await this.db
      .select({
        fileKey: kbPageAttachments.fileKey,
        fileName: kbPageAttachments.fileName,
        mimeType: kbPageAttachments.mimeType,
      })
      .from(kbPageAttachments)
      .where(
        and(
          eq(kbPageAttachments.id, attachmentId),
          eq(kbPageAttachments.pageId, articleId),
          eq(kbPageAttachments.orgId, orgId),
          isNull(kbPageAttachments.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Attachment not found");

    const downloadUrl = await this.storage.getFileUrl(orgId, row.fileKey, ATTACHMENT_DOWNLOAD_EXPIRY_SECONDS);
    return { fileName: row.fileName, mimeType: row.mimeType, downloadUrl };
  }
}
