import { Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { Public } from "../../common/auth/public.decorator";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { kbArticleAttachments, kbArticles } from "../../db/schema";
import { StorageService } from "./storage.service";
import { kbAttachmentsQuerySchema, type KbAttachmentsQueryInput } from "./dto/storage.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { kbAttachmentListResponseSchema } from "./dto/storage-response.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import {
  buildListResponse,
  paginateOffset,
  type ListResponse,
} from "../../common/pagination/pagination";
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
  @ResponseSchema(kbAttachmentListResponseSchema)
  @Validate({ params: slugParams, query: kbAttachmentsQuerySchema })
  async listAttachments(
    @Param("slug") slug: string,
    @Query() query: KbAttachmentsQueryInput,
  ): Promise<ListResponse<AttachmentResponse>> {
    const { org, page, limit: pageSize } = query;
    const { limit, offset } = paginateOffset({ page, pageSize });

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

    const where = and(
      eq(kbArticleAttachments.articleId, article.id),
      eq(kbArticleAttachments.orgId, org),
    );

    // The count is what makes the envelope worth having: a `page` query param with no total
    // leaves the caller guessing whether a short page is the last one.
    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          id: kbArticleAttachments.id,
          fileName: kbArticleAttachments.fileName,
          fileKey: kbArticleAttachments.fileKey,
          fileSize: kbArticleAttachments.fileSize,
          mimeType: kbArticleAttachments.mimeType,
          createdAt: kbArticleAttachments.createdAt,
        })
        .from(kbArticleAttachments)
        .where(where)
        .orderBy(desc(kbArticleAttachments.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(kbArticleAttachments).where(where),
    ]);

    const storageReady = this.storage.isConfigured();

    const items = await Promise.all(
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

    return buildListResponse(items, Number(countRow?.total ?? 0), { page, pageSize });
  }
}
