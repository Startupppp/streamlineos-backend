import { Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { kbArticleAttachments, kbArticles } from "../../db/schema";
import { StorageService } from "./storage.service";
import { kbAttachmentsQuerySchema, type KbAttachmentsQueryInput } from "./dto/storage.schemas";

const DOWNLOAD_EXPIRY_SECONDS = 3600;

@Public()
@Controller("public/kb")
export class StorageKbController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  @Get(":slug/attachments")
  async listAttachments(
    @Param("slug") slug: string,
    @Query(new ZodValidationPipe(kbAttachmentsQuerySchema)) query: KbAttachmentsQueryInput,
  ) {
    const { org } = query;

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
      .orderBy(desc(kbArticleAttachments.createdAt));

    const storageReady = this.storage.isConfigured();

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        fileName: row.fileName,
        fileSize: row.fileSize,
        mimeType: row.mimeType,
        createdAt: row.createdAt,
        downloadUrl: storageReady
          ? await this.storage.getFileUrl(row.fileKey, DOWNLOAD_EXPIRY_SECONDS)
          : null,
      })),
    );
  }
}
