import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, isNull, max, or, sql, type SQL } from "drizzle-orm";
import { kbPages, kbSpaces, kbImportJobs, kbExportJobs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { StorageService } from "../../storage/storage.service";
import type { ExportPageInput, ImportPagesInput } from "./dto/kb-import-export.schemas";
import { importItemSchema } from "./dto/kb-import-export.schemas";
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

type ImportJobRow = typeof kbImportJobs.$inferSelect;
type ExportJobRow = typeof kbExportJobs.$inferSelect;
type ImportJobPage = CursorPage<ImportJobRow>;
type ExportJobPage = CursorPage<ExportJobRow>;

type ExportResult = {
  jobId: number;
  format: "markdown" | "html";
  content: string;
};

type ImportAccepted = {
  jobId: number;
  status: "pending";
};

type ImportDryRunResult = {
  total: number;
  wouldSucceed: number;
  wouldSkip: number;
  invalidItems: string[];
};

type CancelResult = {
  status: string;
  message: string;
};

@Injectable()
export class KbImportExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly planLimits: PlanLimitsService,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly storage: StorageService,
  ) {}

  async exportPage(
    user: CurrentUserContext,
    pageId: number,
    input: ExportPageInput,
  ): Promise<ExportResult> {
    await this.auth.assertPageAccess(user, pageId, "view");
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
      ),
      columns: { id: true, title: true, contentText: true },
    });
    if (!page) throw new NotFoundException("Page not found");

    const content =
      input.format === "markdown"
        ? toMarkdown(page.title, page.contentText)
        : toHtml(page.title, page.contentText);

    const [job] = await this.db
      .insert(kbExportJobs)
      .values({
        orgId: user.orgId,
        scopeType: "page",
        scopeId: pageId,
        format: input.format,
        status: "completed",
        createdById: user.userId,
      })
      .returning();
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

  async importPages(
    user: CurrentUserContext,
    input: ImportPagesInput,
  ): Promise<ImportAccepted> {
    const orgId = user.orgId;
    const items = input.items;

    const binaryItems = items.filter((i) => i.contentText?.includes("\0") ?? false);
    if (binaryItems.length > 0) {
      throw new BadRequestException(
        `Items contain binary content: ${binaryItems.map((i) => i.title).join(", ")}`,
      );
    }

    await this.planLimits.assertWithinLimit(orgId, "kbPages", items.length);

    if (input.spaceId !== undefined) {
      const space = await this.db.query.kbSpaces.findFirst({
        where: and(
          eq(kbSpaces.id, input.spaceId),
          eq(kbSpaces.orgId, orgId),
          isNull(kbSpaces.deletedAt),
        ),
        columns: { id: true },
      });
      if (!space) throw new NotFoundException("Space not found");
    }

    const parentIds = [
      ...new Set(items.map(function getParent(i) {
        return i.parentPageId ?? null;
      })),
    ];
    const nonNullParentIds = parentIds.filter((id): id is number => id !== null);
    if (nonNullParentIds.length > 0) {
      const ownedParents = await this.db
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            inArray(kbPages.id, nonNullParentIds),
            isNull(kbPages.deletedAt),
          ),
        );
      const ownedParentIds = new Set(ownedParents.map((r) => r.id));
      const foreignParentIds = nonNullParentIds.filter((id) => !ownedParentIds.has(id));
      if (foreignParentIds.length > 0) {
        throw new BadRequestException(`Unknown parent page(s): ${foreignParentIds.join(", ")}`);
      }
    }

    const [job] = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(kbImportJobs)
        .values({
          orgId,
          sourceType: input.sourceType,
          status: "pending",
          totalItems: items.length,
          processedItems: 0,
          succeededItems: 0,
          failedItems: 0,
          duplicateItems: 0,
          createdById: user.userId,
        })
        .returning();

      const newJob = inserted[0];
      if (!newJob) throw new InternalServerErrorException("Failed to create import job");

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_import_job",
        aggregateId: String(newJob.id),
        aggregateVersion: Date.now(),
        eventType: "kb.import.process",
        payload: {
          jobId: newJob.id,
          userId: user.userId,
          orgId,
          input: { ...input },
        },
        occurredAt: new Date(),
      });

      return inserted;
    });

    if (!job) throw new InternalServerErrorException("Failed to create import job");

    this.audit.log({
      action: "kb.pages.import.queued",
      userId: user.userId,
      orgId,
      metadata: { jobId: job.id, total: items.length },
    });

    return { jobId: job.id, status: "pending" };
  }

  async dryRunImport(
    user: CurrentUserContext,
    input: ImportPagesInput,
  ): Promise<ImportDryRunResult> {
    const orgId = user.orgId;
    const items = input.items;

    const invalidItems: string[] = [];
    for (const item of items) {
      if (item.contentText?.includes("\0") ?? false) invalidItems.push(item.title);
    }
    const validItems = items.filter((i) => !(i.contentText?.includes("\0") ?? false));

    if (input.spaceId !== undefined) {
      const space = await this.db.query.kbSpaces.findFirst({
        where: and(
          eq(kbSpaces.id, input.spaceId),
          eq(kbSpaces.orgId, orgId),
          isNull(kbSpaces.deletedAt),
        ),
        columns: { id: true },
      });
      if (!space) throw new NotFoundException("Space not found");
    }

    const pageValues = validItems.map((item) => ({
      title: item.title,
      externalId: item.externalId ?? null,
      externalSource: item.externalSource ?? null,
    }));

    function hasExternalRef(
      row: (typeof pageValues)[number],
    ): row is (typeof pageValues)[number] & { externalId: string; externalSource: string } {
      return row.externalId !== null && row.externalSource !== null;
    }

    const withRef = pageValues.filter(hasExternalRef);
    const withoutRef = pageValues.filter((v) => !hasExternalRef(v));

    let wouldSkip = 0;

    if (withRef.length > 0 && input.duplicatePolicy === "skip") {
      const existing = await this.db
        .select({
          externalSource: kbPages.externalSource,
          externalId: kbPages.externalId,
        })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            or(
              ...withRef.map((v) =>
                and(
                  eq(kbPages.externalSource, v.externalSource),
                  eq(kbPages.externalId, v.externalId),
                ),
              ),
            ),
          ),
        );
      const existingKeys = new Set(
        existing.map((e) => `${e.externalSource}::${e.externalId}`),
      );
      wouldSkip += withRef.filter(
        (v) => existingKeys.has(`${v.externalSource}::${v.externalId}`),
      ).length;
    }

    if (withoutRef.length > 0 && input.duplicatePolicy === "skip") {
      const plainTitles = withoutRef.map((v) => v.title);
      const existingPlain = await this.db
        .select({ title: kbPages.title })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            inArray(kbPages.title, plainTitles),
            isNull(kbPages.deletedAt),
          ),
        );
      const existingTitles = new Set(existingPlain.map((r) => r.title));
      wouldSkip += withoutRef.filter((v) => existingTitles.has(v.title)).length;
    }

    const wouldSucceed = validItems.length - wouldSkip;

    return { total: items.length, wouldSucceed, wouldSkip, invalidItems };
  }

  async getImportJob(orgId: string, jobId: number): Promise<ImportJobRow> {
    const rows = await this.db
      .select({
        id: kbImportJobs.id,
        orgId: kbImportJobs.orgId,
        sourceType: kbImportJobs.sourceType,
        fileKey: kbImportJobs.fileKey,
        status: kbImportJobs.status,
        totalItems: kbImportJobs.totalItems,
        processedItems: kbImportJobs.processedItems,
        succeededItems: kbImportJobs.succeededItems,
        failedItems: kbImportJobs.failedItems,
        duplicateItems: kbImportJobs.duplicateItems,
        errorReport: kbImportJobs.errorReport,
        createdById: kbImportJobs.createdById,
        createdAt: kbImportJobs.createdAt,
        updatedAt: kbImportJobs.updatedAt,
      })
      .from(kbImportJobs)
      .where(and(eq(kbImportJobs.orgId, orgId), eq(kbImportJobs.id, jobId)))
      .limit(1);
    const job = rows[0];
    if (!job) throw new NotFoundException("Import job not found");
    return job as ImportJobRow;
  }

  async cancelImportJob(orgId: string, jobId: number): Promise<CancelResult> {
    const rows = await this.db
      .select({ status: kbImportJobs.status })
      .from(kbImportJobs)
      .where(and(eq(kbImportJobs.orgId, orgId), eq(kbImportJobs.id, jobId)))
      .limit(1);
    const job = rows[0];
    if (!job) throw new NotFoundException("Import job not found");

    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      throw new ConflictException(`Import job is already ${job.status}`);
    }

    await this.db
      .update(kbImportJobs)
      .set({ status: "cancelled" })
      .where(and(eq(kbImportJobs.orgId, orgId), eq(kbImportJobs.id, jobId)));

    const message =
      job.status === "processing"
        ? "Cancel requested — processing has already begun and may complete before the cancel takes effect"
        : "Import job cancelled";

    return { status: "cancelled", message };
  }

  async retryImportJob(
    user: CurrentUserContext,
    jobId: number,
  ): Promise<ImportAccepted> {
    const orgId = user.orgId;
    const rows = await this.db
      .select({
        id: kbImportJobs.id,
        status: kbImportJobs.status,
        sourceType: kbImportJobs.sourceType,
        errorReport: kbImportJobs.errorReport,
      })
      .from(kbImportJobs)
      .where(and(eq(kbImportJobs.orgId, orgId), eq(kbImportJobs.id, jobId)))
      .limit(1);
    const job = rows[0];
    if (!job) throw new NotFoundException("Import job not found");
    if (job.status === "pending" || job.status === "processing") {
      throw new ConflictException("Import job is still in progress");
    }
    const report = job.errorReport as Record<string, unknown> | null;
    const rawFailedItems = Array.isArray(report?.["failedItems"]) ? report["failedItems"] : [];
    const failedItems = rawFailedItems.flatMap((raw) => {
      const parsed = importItemSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    if (failedItems.length === 0) {
      throw new ConflictException("No retryable failed items in this job");
    }
    const [newJob] = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(kbImportJobs)
        .values({
          orgId,
          sourceType: job.sourceType,
          status: "pending",
          totalItems: failedItems.length,
          processedItems: 0,
          succeededItems: 0,
          failedItems: 0,
          duplicateItems: 0,
          createdById: user.userId,
        })
        .returning();
      const newJobRow = inserted[0];
      if (!newJobRow) throw new InternalServerErrorException("Failed to create retry job");
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_import_job",
        aggregateId: String(newJobRow.id),
        aggregateVersion: Date.now(),
        eventType: "kb.import.process",
        payload: {
          jobId: newJobRow.id,
          userId: user.userId,
          orgId,
          input: {
            sourceType: job.sourceType as "markdown" | "html" | "zip",
            items: failedItems,
            visibility: "org",
            duplicatePolicy: "skip",
          },
        },
        occurredAt: new Date(),
      });
      return inserted;
    });
    if (!newJob) throw new InternalServerErrorException("Failed to create retry job");
    this.audit.log({
      action: "kb.pages.import.retried",
      userId: user.userId,
      orgId,
      metadata: { originalJobId: jobId, retryJobId: newJob.id, itemCount: failedItems.length },
    });
    return { jobId: newJob.id, status: "pending" };
  }

  async listImportJobs(orgId: string, cursor?: string): Promise<ImportJobPage> {
    const position = decodeTimestampCursor(cursor);
    const filters: SQL[] = [eq(kbImportJobs.orgId, orgId)];
    if (position)
      filters.push(keysetBeforeMicros(kbImportJobs.createdAt, kbImportJobs.id, position));
    const rows = await this.db
      .select({
        id: kbImportJobs.id,
        orgId: kbImportJobs.orgId,
        sourceType: kbImportJobs.sourceType,
        fileKey: kbImportJobs.fileKey,
        status: kbImportJobs.status,
        totalItems: kbImportJobs.totalItems,
        processedItems: kbImportJobs.processedItems,
        succeededItems: kbImportJobs.succeededItems,
        failedItems: kbImportJobs.failedItems,
        duplicateItems: kbImportJobs.duplicateItems,
        errorReport: kbImportJobs.errorReport,
        createdById: kbImportJobs.createdById,
        createdAt: kbImportJobs.createdAt,
        updatedAt: kbImportJobs.updatedAt,
        createdAtText: microsecondCursorValue(kbImportJobs.createdAt),
      })
      .from(kbImportJobs)
      .where(and(...filters))
      .orderBy(desc(kbImportJobs.createdAt), desc(kbImportJobs.id))
      .limit(PAGE_SIZE_CAP + 1);
    return buildCursorPage(rows, PAGE_SIZE_CAP, (row) => ({
      sortValue: row.createdAtText ?? "",
      id: String(row.id),
    }));
  }
}
