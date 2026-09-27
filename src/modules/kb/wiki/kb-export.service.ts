import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { kbPages, kbExportJobs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ExportPageInput } from "./dto/kb-import-export.schemas";
import { toMarkdown, toHtml } from "./kb-export-serializer";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import {
  buildCursorPage,
  decodeTimestampCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

type ExportJobRow = typeof kbExportJobs.$inferSelect;
type ExportJobPage = CursorPage<ExportJobRow>;

type ExportResult = {
  jobId: number;
  format: "markdown" | "html";
  content: string;
};

const EXPORT_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class KbExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly storage: StorageService,
  ) {}

  async exportPage(
    user: CurrentUserContext,
    pageId: number,
    input: ExportPageInput,
  ): Promise<ExportResult> {
    let page: { id: number; title: string; contentText: string | null } | undefined;

    await runInTenantTransaction(
      this.db,
      async () => {
        await this.auth.assertPageAccess(user, pageId, "view");
        page = await this.db.query.kbPages.findFirst({
          where: and(
            eq(kbPages.id, pageId),
            eq(kbPages.orgId, user.orgId),
            isNull(kbPages.deletedAt),
          ),
          columns: { id: true, title: true, contentText: true },
        });
      },
      { orgId: user.orgId },
    );

    if (!page) throw new NotFoundException("Page not found");

    const content =
      input.format === "markdown"
        ? toMarkdown(page.title, page.contentText)
        : toHtml(page.title, page.contentText);

    const ext = input.format === "markdown" ? "md" : "html";
    const mimeType = input.format === "markdown" ? "text/markdown" : "text/html";
    const fileName = `${pageId}-${randomUUID()}.${ext}`;

    const uploaded = await this.storage.uploadFile(
      user.orgId,
      Buffer.from(content, "utf-8"),
      "kb-exports",
      fileName,
      mimeType,
    );

    const expiresAt = new Date(Date.now() + EXPORT_TTL_SECONDS * 1000);

    let job: { id: number } | undefined;
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [inserted] = await tx
          .insert(kbExportJobs)
          .values({
            orgId: user.orgId,
            scopeType: "page",
            scopeId: pageId,
            format: input.format,
            status: "completed",
            fileKey: uploaded.key,
            expiresAt,
            createdById: user.userId,
          })
          .returning({ id: kbExportJobs.id });
        if (!inserted) throw new InternalServerErrorException("Failed to create export job");
        job = inserted;
      },
      { orgId: user.orgId },
    );

    if (!job) throw new InternalServerErrorException("Failed to create export job");

    this.audit.log({
      action: "kb.page.exported",
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_page",
      resourceId: String(pageId),
      metadata: { format: input.format, jobId: job.id },
    });

    return { jobId: job.id, format: input.format, content };
  }

  async listExportJobs(orgId: string, cursor?: string): Promise<ExportJobPage> {
    const position = decodeTimestampCursor(cursor);
    const filters: SQL[] = [eq(kbExportJobs.orgId, orgId)];
    if (position)
      filters.push(keysetBeforeMicros(kbExportJobs.createdAt, kbExportJobs.id, position));
    const rows = await this.db
      .select({
        id: kbExportJobs.id,
        orgId: kbExportJobs.orgId,
        scopeType: kbExportJobs.scopeType,
        scopeId: kbExportJobs.scopeId,
        format: kbExportJobs.format,
        status: kbExportJobs.status,
        fileKey: kbExportJobs.fileKey,
        expiresAt: kbExportJobs.expiresAt,
        createdById: kbExportJobs.createdById,
        createdAt: kbExportJobs.createdAt,
        updatedAt: kbExportJobs.updatedAt,
        createdAtText: microsecondCursorValue(kbExportJobs.createdAt),
      })
      .from(kbExportJobs)
      .where(and(...filters))
      .orderBy(desc(kbExportJobs.createdAt), desc(kbExportJobs.id))
      .limit(PAGE_SIZE_CAP + 1);
    return buildCursorPage(rows, PAGE_SIZE_CAP, (row) => ({
      sortValue: row.createdAtText ?? "",
      id: String(row.id),
    }));
  }

  async getExportJobDownload(
    orgId: string,
    jobId: number,
  ): Promise<{ downloadUrl: string }> {
    const rows = await this.db
      .select({
        id: kbExportJobs.id,
        fileKey: kbExportJobs.fileKey,
        expiresAt: kbExportJobs.expiresAt,
      })
      .from(kbExportJobs)
      .where(and(eq(kbExportJobs.orgId, orgId), eq(kbExportJobs.id, jobId)))
      .limit(1);
    const job = rows[0];
    if (!job) throw new NotFoundException("Export job not found");
    if (!job.fileKey) throw new NotFoundException("Export file not available");
    if (!job.expiresAt || job.expiresAt <= new Date())
      throw new NotFoundException("Export has expired");
    const expiresIn = Math.floor((job.expiresAt.getTime() - Date.now()) / 1000);
    const downloadUrl = await this.storage.getFileUrl(orgId, job.fileKey, expiresIn);
    return { downloadUrl };
  }
}
