import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { Public } from "../../common/auth/public.decorator";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { kbPageAttachments } from "../../db/schema";
import { findPublicDeliverableDocument } from "../kb/core/kb-document-delivery-access";
import { StorageService } from "./storage.service";
import {
  kbAttachmentsQuerySchema,
  type KbAttachmentsQueryInput,
} from "./dto/storage.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { kbAttachmentListResponseSchema } from "./dto/storage-response.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  buildListResponse,
  paginateOffset,
  type ListResponse,
} from "../../common/pagination/pagination";
import { z } from "zod";

const slugParams = z.object({ slug: z.string().min(1) }).strict();

type AttachmentResponse = Pick<
  typeof kbPageAttachments.$inferSelect,
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

    const { rows, countRow } = await runInNewTenantTransaction(
      this.db,
      org,
      async (tx) => {
        const article = await findPublicDeliverableDocument(tx, org, slug);

        if (!article) throw new NotFoundException("Article not found");

        const where = and(
          eq(kbPageAttachments.pageId, article.id),
          eq(kbPageAttachments.orgId, org),
          isNull(kbPageAttachments.deletedAt),
        );

        const [pageRows, [total]] = await Promise.all([
          tx
            .select({
              id: kbPageAttachments.id,
              fileName: kbPageAttachments.fileName,
              fileKey: kbPageAttachments.fileKey,
              fileSize: kbPageAttachments.fileSize,
              mimeType: kbPageAttachments.mimeType,
              createdAt: kbPageAttachments.createdAt,
            })
            .from(kbPageAttachments)
            .where(where)
            .orderBy(desc(kbPageAttachments.createdAt))
            .limit(limit)
            .offset(offset),
          tx.select({ total: count() }).from(kbPageAttachments).where(where),
        ]);

        return { rows: pageRows, countRow: total };
      },
    );

    const storageReady = this.storage.isConfigured();

    const items = await Promise.all(
      rows.map(
        async (row): Promise<AttachmentResponse> => ({
          id: row.id,
          fileName: row.fileName,
          fileSize: row.fileSize,
          mimeType: row.mimeType,
          createdAt: row.createdAt,
          downloadUrl: storageReady
            ? await this.storage.getFileUrl(
                org,
                row.fileKey,
                DOWNLOAD_EXPIRY_SECONDS,
              )
            : null,
        }),
      ),
    );

    return buildListResponse(items, Number(countRow?.total ?? 0), {
      page,
      pageSize,
    });
  }
}
