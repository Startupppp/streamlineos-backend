import { Injectable, Inject, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { kbImportJobs, kbPages } from "../../../db/schema";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { AuditService } from "../../../common/audit/audit.service";
import { importPagesSchema } from "./dto/kb-import-export.schemas";
import { KbPageWriterService } from "./kb-page-writer.service";

const importEventPayloadSchema = z.object({
  jobId: z.number().int(),
  userId: z.string(),
  orgId: z.string(),
  input: importPagesSchema,
});

@Injectable()
export class KbImportProcessConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = "kb.import.process";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly outboxRegistry: OutboxConsumerRegistry,
    private readonly audit: AuditService,
    private readonly writer: KbPageWriterService,
  ) {}

  onModuleInit(): void {
    this.outboxRegistry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const parsed = importEventPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return;
    const { jobId, userId, orgId, input } = parsed.data;

    let shouldProcess = false;
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [job] = await tx
        .select({ status: kbImportJobs.status })
        .from(kbImportJobs)
        .where(and(eq(kbImportJobs.id, jobId), eq(kbImportJobs.orgId, orgId)))
        .limit(1);
      if (!job || (job.status !== "pending" && job.status !== "processing")) return;
      await tx
        .update(kbImportJobs)
        .set({ status: "processing" })
        .where(and(eq(kbImportJobs.id, jobId), eq(kbImportJobs.orgId, orgId)));
      shouldProcess = true;
    });
    if (!shouldProcess) return;

    let succeeded = 0;
    let failed = 0;
    let duplicates = 0;
    const failedTitles: string[] = [];
    const failedItems: typeof input.items = [];
    let processError: unknown = null;

    try {
      const items = input.items;
      const parentIds = [...new Set(items.map((i) => i.parentPageId ?? null))];
      const nonNullParentIds = parentIds.filter((id): id is number => id !== null);

      const sortOffsets = new Map<number | null, number>();
      if (parentIds.length > 0) {
        const wantsRootGroup = parentIds.some((id) => id === null);
        const parentScope =
          nonNullParentIds.length === 0
            ? isNull(kbPages.parentPageId)
            : wantsRootGroup
              ? or(inArray(kbPages.parentPageId, nonNullParentIds), isNull(kbPages.parentPageId))
              : inArray(kbPages.parentPageId, nonNullParentIds);

        const grouped = await runInNewTenantTransaction(this.db, orgId, async (tx) =>
          tx
            .select({ parentPageId: kbPages.parentPageId, maxSort: max(kbPages.sortOrder) })
            .from(kbPages)
            .where(and(eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt), parentScope))
            .groupBy(kbPages.parentPageId),
        );

        for (const row of grouped)
          sortOffsets.set(row.parentPageId ?? null, (row.maxSort ?? 0) + 100);
        for (const parentId of parentIds)
          if (!sortOffsets.has(parentId)) sortOffsets.set(parentId, 100);
      }

      const counters = new Map<number | null, number>(
        parentIds.map((pid) => [pid ?? null, 0]),
      );
      const pageValues = items.map((item) => {
        const pid = item.parentPageId ?? null;
        const counter = counters.get(pid) ?? 0;
        const base = sortOffsets.get(pid) ?? 100;
        counters.set(pid, counter + 1);
        return {
          orgId,
          parentPageId: item.parentPageId ?? null,
          spaceId: input.spaceId ?? null,
          visibility: input.visibility,
          title: item.title,
          contentText: item.contentText ?? null,
          sortOrder: base + counter * 100,
          createdById: userId,
          lastEditedById: userId,
          externalId: item.externalId ?? null,
          externalSource: item.externalSource ?? null,
        };
      });

      type PageInsertRow = (typeof pageValues)[number];
      function hasExternalRef(
        row: PageInsertRow,
      ): row is PageInsertRow & { externalId: string; externalSource: string } {
        return row.externalId !== null && row.externalSource !== null;
      }

      const withRef = pageValues.filter(hasExternalRef);
      const withoutRef = pageValues.filter((v) => !hasExternalRef(v));

      if (withRef.length > 0) {
        let toUpsert = withRef;
        if (input.duplicatePolicy === "skip") {
          toUpsert = await runInNewTenantTransaction(this.db, orgId, async (tx) => {
            const existing = await tx
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
            return withRef.filter(
              (v) => !existingKeys.has(`${v.externalSource}::${v.externalId}`),
            );
          });
        }
        duplicates += withRef.length - toUpsert.length;

        if (toUpsert.length > 0) {
          await runInNewTenantTransaction(this.db, orgId, async (tx) => {
            try {
              const inserted = await tx
                .insert(kbPages)
                .values(toUpsert)
                .onConflictDoUpdate({
                  target: [kbPages.orgId, kbPages.externalSource, kbPages.externalId],
                  targetWhere: sql`${kbPages.externalId} IS NOT NULL`,
                  set: {
                    title: sql`excluded.title`,
                    contentText: sql`excluded.content_text`,
                    updatedAt: sql`now()`,
                    lastEditedById: sql`excluded.last_edited_by_id`,
                  },
                })
                .returning({
                  id: kbPages.id,
                  contentRevision: kbPages.contentRevision,
                  aclRevision: kbPages.aclRevision,
                  contentText: kbPages.contentText,
                });
              succeeded += inserted.length;
              await this.writer.commitManyPageChanges(tx, { orgId, pages: inserted });
            } catch {
              failed += toUpsert.length;
              failedTitles.push(...toUpsert.map((v) => v.title));
              failedItems.push(
                ...toUpsert.map((v) => ({
                  title: v.title,
                  contentText: v.contentText ?? undefined,
                  parentPageId: v.parentPageId ?? undefined,
                  externalId: v.externalId,
                  externalSource: v.externalSource,
                })),
              );
            }
          });
        }
      }

      if (withoutRef.length > 0) {
        const plainTitles = withoutRef.map((v) => v.title);
        await runInNewTenantTransaction(this.db, orgId, async (tx) => {
          let toInsert = withoutRef;
          if (input.duplicatePolicy === "skip") {
            const existingPlain = await tx
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
            duplicates += withoutRef.filter((v) => existingTitles.has(v.title)).length;
            toInsert = withoutRef.filter((v) => !existingTitles.has(v.title));
          }
          if (toInsert.length > 0) {
            try {
              const inserted = await tx
                .insert(kbPages)
                .values(toInsert)
                .onConflictDoNothing()
                .returning({
                  id: kbPages.id,
                  contentRevision: kbPages.contentRevision,
                  aclRevision: kbPages.aclRevision,
                  contentText: kbPages.contentText,
                });
              succeeded += inserted.length;
              await this.writer.commitManyPageChanges(tx, { orgId, pages: inserted });
            } catch {
              failed += toInsert.length;
              failedTitles.push(...toInsert.map((v) => v.title));
              failedItems.push(
                ...toInsert.map((v) => ({
                  title: v.title,
                  contentText: v.contentText ?? undefined,
                  parentPageId: v.parentPageId ?? undefined,
                })),
              );
            }
          }
        });
      }
    } catch (err) {
      processError = err;
    }

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx
        .update(kbImportJobs)
        .set({
          status: processError ? "failed" : "completed",
          succeededItems: succeeded,
          failedItems: failed,
          duplicateItems: duplicates,
          processedItems: input.items.length,
          totalItems: input.items.length,
          errorReport: failedTitles.length > 0 ? { failedTitles, failedItems } : null,
        })
        .where(
          and(
            eq(kbImportJobs.id, jobId),
            eq(kbImportJobs.orgId, orgId),
            eq(kbImportJobs.status, "processing"),
          ),
        );
    });

    this.audit.log({
      action: "kb.pages.imported",
      userId,
      orgId,
      metadata: { jobId, total: input.items.length, succeeded, failed, duplicates },
    });

    if (processError) throw processError;
  }
}
