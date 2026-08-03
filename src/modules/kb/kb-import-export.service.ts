import { BadRequestException, Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { kbPages, kbImportJobs, kbExportJobs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { ExportPageInput, ImportPagesInput } from "./dto/kb-import-export.schemas";
import { toMarkdown, toHtml } from "./kb-export-serializer";
import { assertPageAccessible } from "./kb-page-access.util";

type ImportJobRow = typeof kbImportJobs.$inferSelect;
type ExportJobRow = typeof kbExportJobs.$inferSelect;

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
  ) {}

  async exportPage(
    user: CurrentUserContext,
    pageId: number,
    input: ExportPageInput,
  ): Promise<ExportResult> {
    await assertPageAccessible(this.db, user, pageId);
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

  async listExportJobs(orgId: string): Promise<ExportJobRow[]> {
    return this.db
      .select()
      .from(kbExportJobs)
      .where(eq(kbExportJobs.orgId, orgId))
      .orderBy(desc(kbExportJobs.createdAt))
      .limit(100);
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
    for (const parentId of parentIds) {
      const [row] = await this.db
        .select({ maxSort: max(kbPages.sortOrder) })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            isNull(kbPages.deletedAt),
            parentId != null
              ? eq(kbPages.parentPageId, parentId)
              : isNull(kbPages.parentPageId),
          ),
        );
      sortOffsets.set(parentId ?? null, (row?.maxSort ?? 0) + 100);
    }

    let succeeded = 0;
    let failed = 0;

    await this.db.transaction(async function insertPages(tx) {
      const counters = new Map<number | null, number>(
        parentIds.map(function initCounter(pid) {
          return [pid ?? null, 0];
        }),
      );

      for (const item of items) {
        const pid = item.parentPageId ?? null;
        const counter = counters.get(pid) ?? 0;
        const base = sortOffsets.get(pid) ?? 100;
        const sortOrder = base + counter * 100;
        counters.set(pid, counter + 1);

        try {
          await tx.insert(kbPages).values({
            orgId,
            parentPageId: item.parentPageId ?? null,
            title: item.title,
            contentText: item.contentText ?? null,
            sortOrder,
            createdById: user.userId,
            lastEditedById: user.userId,
          });
          succeeded++;
        } catch {
          failed++;
        }
      }
    });

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

  async listImportJobs(orgId: string): Promise<ImportJobRow[]> {
    return this.db
      .select()
      .from(kbImportJobs)
      .where(eq(kbImportJobs.orgId, orgId))
      .orderBy(desc(kbImportJobs.createdAt))
      .limit(100);
  }
}
