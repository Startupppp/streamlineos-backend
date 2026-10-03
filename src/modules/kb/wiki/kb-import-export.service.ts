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
import { kbPages, kbSpaces, kbImportJobs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ImportPagesInput } from "./dto/kb-import-export.schemas";
import { importItemSchema, importPagesSchema } from "./dto/kb-import-export.schemas";
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
type ImportJobPage = CursorPage<ImportJobRow>;

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
  ) {}

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
    return job;
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

    const retryableSourceType = importPagesSchema.shape.sourceType.safeParse(job.sourceType);
    if (!retryableSourceType.success) {
      throw new ConflictException("Source type of original job cannot be retried");
    }

    const report: Record<string, unknown> | null = job.errorReport ?? null;
    const rawRetryItems = Array.isArray(report?.["retryItems"]) ? report["retryItems"] : [];
    const retryItems = rawRetryItems.flatMap((raw) => {
      const parsed = importItemSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    if (retryItems.length === 0) {
      throw new ConflictException("No retryable failed items in this job");
    }
    const [newJob] = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(kbImportJobs)
        .values({
          orgId,
          sourceType: retryableSourceType.data,
          status: "pending",
          totalItems: retryItems.length,
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
            sourceType: retryableSourceType.data,
            items: retryItems,
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
      metadata: { originalJobId: jobId, retryJobId: newJob.id, itemCount: retryItems.length },
    });
    return { jobId: newJob.id, status: "pending" };
  }

  async listImportJobs(orgId: string, cursor?: string, limit = PAGE_SIZE_CAP): Promise<ImportJobPage> {
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
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAtText ?? "",
      id: String(row.id),
    }));
  }
}
