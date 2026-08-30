import { Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { kbArticleAttachments, kbArticles } from "../../db/schema";
import { StorageService } from "./storage.service";
import { kbAttachmentsQuerySchema, type KbAttachmentsQueryInput } from "./dto/storage.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const slugParams = z.object({ slug: z.string().min(1) }).strict();

type AttachmentResponse = Pick<
  typeof kbArticleAttachments.$inferSelect,
  "id" | "fileName" | "fileSize" | "mimeType" | "createdAt"
> & { downloadUrl: string | null };

const DOWNLOAD_EXPIRY_SECONDS = 3600;

@Public()
@Controller("public/kb")
export class StorageKbController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  @Get(":slug/attachments")
  @Validate({ params: slugParams })
  async listAttachments(
    @Param("slug") slug: string,
    @Query(new ZodValidationPipe(kbAttachmentsQuerySchema)) query: KbAttachmentsQueryInput,
  ): Promise<AttachmentResponse[]> {
    const { org, page, limit } = query;
    const offset = (page - 1) * limit;

    const [article] = await this.db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .where(
        and(
          eq(kbArticles.orgId, org),
          eq(kbArticles.slug, slug),
          eq(kbArticles.status, "published"),
          eq(kbArticles.visibility, "public"),
        ),
      );

    if (!article) throw new NotFoundException("Article not found");

    const rows = await this.db
      .select({
        id: kbArticleAttachments.id,
        fileName: kbArticleAttachments.fileName,
        fileKey: kbArticleAttachments.fileKey,
        fileSize: kbArticleAttachments.fileSize,
        mimeType: kbArticleAttachments.mimeType,
        createdAt: kbArticleAttachments.createdAt,
      })
      .from(kbArticleAttachments)
      .where(and(eq(kbArticleAttachments.articleId, article.id), eq(kbArticleAttachments.orgId, org)))
      .orderBy(desc(kbArticleAttachments.createdAt))
      .limit(limit)
      .offset(offset);

    const storageReady = this.storage.isConfigured();

    return Promise.all(
      rows.map(async (row): Promise<AttachmentResponse> => ({
        id: row.id,
        fileName: row.fileName,
        fileSize: row.fileSize,
        mimeType: row.mimeType,
        createdAt: row.createdAt,
        downloadUrl: storageReady
          ? await this.storage.getFileUrl(org, row.fileKey, DOWNLOAD_EXPIRY_SECONDS)
          : null,
      })),
    );
  }
}
