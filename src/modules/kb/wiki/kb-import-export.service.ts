import { BadRequestException, Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, max, or, sql, type SQL } from "drizzle-orm";
import { kbPages, kbImportJobs, kbExportJobs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ExportPageInput, ImportPagesInput } from "./dto/kb-import-export.schemas";
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

type ImportResult = {
  jobId: number;
  succeeded: number;
  failed: number;
  total: number;
};

@Injectable()
export class KbImportExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly planLimits: PlanLimitsService,
    private readonly auth: KnowledgeAuthorizationService,
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

  async importPages(
    user: CurrentUserContext,
    input: ImportPagesInput,
  ): Promise<ImportResult> {
    const orgId = user.orgId;
    const items = input.items;

    await this.planLimits.assertWithinLimit(orgId, "kbPages", items.length);

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

    const sortOffsets = new Map<number | null, number>();
    if (parentIds.length > 0) {
      const wantsRootGroup = parentIds.some((id) => id === null);
      const parentScope =
        nonNullParentIds.length === 0
          ? isNull(kbPages.parentPageId)
          : wantsRootGroup
            ? or(inArray(kbPages.parentPageId, nonNullParentIds), isNull(kbPages.parentPageId))
            : inArray(kbPages.parentPageId, nonNullParentIds);
      const grouped = await this.db
        .select({ parentPageId: kbPages.parentPageId, maxSort: max(kbPages.sortOrder) })
        .from(kbPages)
        .where(and(eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt), parentScope))
        .groupBy(kbPages.parentPageId);
      const maxByParent = new Map<number | null, number>(
        grouped.map(function toEntry(row) {
          return [row.parentPageId ?? null, row.maxSort ?? 0];
        }),
      );
      for (const parentId of parentIds)
        sortOffsets.set(parentId, (maxByParent.get(parentId) ?? 0) + 100);
    }

    let succeeded = 0;
    let failed = 0;

    const counters = new Map<number | null, number>(
      parentIds.map(function initCounter(pid) {
        return [pid ?? null, 0];
      }),
    );
    const pageValues = items.map(function buildRow(item) {
      const pid = item.parentPageId ?? null;
      const counter = counters.get(pid) ?? 0;
      const base = sortOffsets.get(pid) ?? 100;
      const sortOrder = base + counter * 100;
      counters.set(pid, counter + 1);
      return {
        orgId,
        parentPageId: item.parentPageId ?? null,
        title: item.title,
        contentText: item.contentText ?? null,
        sortOrder,
        createdById: user.userId,
        lastEditedById: user.userId,
        externalId: item.externalId ?? null,
        externalSource: item.externalSource ?? null,
      };
    });

    const withRef = pageValues.filter((v) => v.externalId !== null);
    const withoutRef = pageValues.filter((v) => v.externalId === null);

    if (withRef.length > 0) {
      try {
        await this.db
          .insert(kbPages)
          .values(withRef)
          .onConflictDoUpdate({
            target: [kbPages.orgId, kbPages.externalSource, kbPages.externalId],
            targetWhere: sql`${kbPages.externalId} IS NOT NULL`,
            set: {
              title: sql`excluded.title`,
              contentText: sql`excluded.content_text`,
              updatedAt: sql`now()`,
              lastEditedById: sql`excluded.last_edited_by_id`,
            },
          });
        succeeded += withRef.length;
      } catch {
        failed += withRef.length;
      }
    }

    if (withoutRef.length > 0) {
      try {
        await this.db.insert(kbPages).values(withoutRef).onConflictDoNothing();
        succeeded += withoutRef.length;
      } catch {
        failed += withoutRef.length;
      }
    }

    const [job] = await this.db
      .insert(kbImportJobs)
      .values({
        orgId,
        sourceType: input.sourceType,
        status: "completed",
        totalItems: items.length,
        processedItems: items.length,
        succeededItems: succeeded,
        failedItems: failed,
        errorReport: {
          itemTitles: items.map((item) => item.title),
        },
        createdById: user.userId,
      })
      .returning();
    if (!job) throw new InternalServerErrorException("Failed to record import job");

    this.audit.log({
      action: "kb.pages.imported",
      userId: user.userId,
      orgId,
      metadata: { jobId: job.id, total: items.length, succeeded, failed },
    });

    return { jobId: job.id, succeeded, failed, total: items.length };
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
