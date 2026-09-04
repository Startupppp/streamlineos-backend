import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { bulkUpdateFromValues } from "../../../common/db/bulk-update";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";
import {
  accFixedAssets, accAssetCategories, accDepreciationRuns, accDepreciationSchedules,
} from "../../../db/schema/accounting/finance-assets";
import { ledgerAccounts } from "../../../db/schema/accounting/accounting";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { systemActor } from "../../../common/auth/system-actor";
import type { ListRunsQuery } from "./dto/assets.schemas";
import { DepreciationReverseService } from "./depreciation-reverse.service";
import {
  buildAssetAccumulationRows,
  buildDepreciationLines,
  categoryAccountIds,
  groupSchedulesByCategory,
} from "./depreciation-posting-lines";

@Injectable()
export class DepreciationRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly reverse: DepreciationReverseService,
  ) {}

  async list(orgId: string, query: ListRunsQuery) {
    const { cursor, limit } = query;
    const pos = decodeCursor(cursor);
    const pageLimit = Math.min(limit, 100);

    const conds = [eq(accDepreciationRuns.orgId, orgId)];
    if (pos) conds.push(keysetBefore(accDepreciationRuns.createdAt, accDepreciationRuns.id, pos));

    const rows = await this.db
      .select()
      .from(accDepreciationRuns)
      .where(and(...conds))
      .orderBy(desc(accDepreciationRuns.createdAt), desc(accDepreciationRuns.id))
      .limit(pageLimit + 1);

    return buildCursorPage(rows, pageLimit, (row) => ({
      sortValue: (row.createdAt ?? new Date(0)).toISOString(),
      id: String(row.id),
    }));
  }

  async runDepreciation(u: CurrentUserContext, periodKey: string) {
    const existing = await this.db
      .select()
      .from(accDepreciationRuns)
      .where(and(eq(accDepreciationRuns.orgId, u.orgId), eq(accDepreciationRuns.periodKey, periodKey)))
      .limit(1);
    if (existing[0]?.status === "POSTED") return existing[0];

    const scheduleRows = await this.db
      .select({
        schedule: accDepreciationSchedules,
        asset: accFixedAssets,
        category: accAssetCategories,
      })
      .from(accDepreciationSchedules)
      .innerJoin(accFixedAssets, eq(accDepreciationSchedules.assetId, accFixedAssets.id))
      .innerJoin(accAssetCategories, eq(accFixedAssets.categoryId, accAssetCategories.id))
      .where(
        and(
          eq(accDepreciationSchedules.orgId, u.orgId),
          eq(accDepreciationSchedules.periodKey, periodKey),
          eq(accDepreciationSchedules.status, "SCHEDULED"),
          eq(accFixedAssets.status, "ACTIVE"),
        ),
      );

    if (scheduleRows.length === 0) {
      throw new BadRequestException(`No scheduled depreciation rows found for period ${periodKey}`);
    }

    const categoryAmounts = groupSchedulesByCategory(scheduleRows);

    const accountRows = await this.db
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(inArray(ledgerAccounts.id, categoryAccountIds(categoryAmounts)), eq(ledgerAccounts.orgId, u.orgId)));
    const codeMap = new Map(accountRows.map((a) => [a.id, a.code]));

    const { lines, totalAmount: roundedTotal } = buildDepreciationLines(categoryAmounts, codeMap, periodKey);

    const entry = await this.posting.persistJournalEntry({
      orgId: u.orgId,
      entryDate: `${periodKey}-01`,
      description: `Depreciation run for ${periodKey}`,
      sourceType: "DEPRECIATION_RUN",
      sourceId: periodKey,
      sourceEvent: "post",
      createdBy: u.userId,
      lines,
    });

    const run = await this.db.transaction(async (tx) => {
      const [insertedRun] = await tx
        .insert(accDepreciationRuns)
        .values({
          orgId: u.orgId,
          periodKey,
          status: "POSTED",
          totalAmount: String(roundedTotal),
          journalEntryId: entry.id,
          createdBy: u.userId,
          postedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [accDepreciationRuns.orgId, accDepreciationRuns.periodKey],
          set: {
            status: "POSTED",
            totalAmount: String(roundedTotal),
            journalEntryId: entry.id,
            postedAt: new Date(),
          },
        })
        .returning();

      if (!insertedRun) throw new Error("Failed to insert depreciation run");

      const allScheduleIds = scheduleRows.map((r) => r.schedule.id);
      await tx
        .update(accDepreciationSchedules)
        .set({ status: "POSTED", runId: insertedRun.id, journalEntryId: entry.id })
        .where(
          and(
            eq(accDepreciationSchedules.orgId, u.orgId),
            inArray(accDepreciationSchedules.id, allScheduleIds),
          ),
        );

      /*
       * One statement for the whole register. The tenant predicate the per-row
       * update was missing is in the WHERE.
       */
      await bulkUpdateFromValues(tx, {
        table: accFixedAssets,
        orgId: u.orgId,
        key: { column: "id", type: "integer" },
        columns: [
          { column: "accumulated_depreciation", type: "numeric" },
          { column: "status", type: "acc_asset_status" },
        ],
        touch: ["updated_at"],
        rows: buildAssetAccumulationRows(scheduleRows),
      });

      return insertedRun;
    });

    await this.dispatch.emit({
      orgId: u.orgId,
      eventKey: "accounting.depreciation.run_posted",
      targetUserIds: [u.userId],
      variables: { periodKey, totalAmount: String(roundedTotal) },
      actorUserId: u.userId,
    });

    this.audit.log({
      action: "POST",
      orgId: u.orgId,
      userId: u.userId,
      resourceType: "depreciation_run",
      resourceId: String(run.id),
      metadata: { periodKey, totalAmount: roundedTotal },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.finAssetsListNamespace(u.orgId));
    return run;
  }

  reverseRun(u: CurrentUserContext, runId: number) {
    return this.reverse.reverseRun(u, runId);
  }

  async runDepreciationForDuePeriods(orgId?: string) {
    const now = new Date();
    const currentPeriodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const duePeriods = await this.db
      .selectDistinct({
        orgId: accDepreciationSchedules.orgId,
        periodKey: accDepreciationSchedules.periodKey,
      })
      .from(accDepreciationSchedules)
      .where(
        and(
          orgId ? eq(accDepreciationSchedules.orgId, orgId) : undefined,
          eq(accDepreciationSchedules.status, "SCHEDULED"),
          lt(accDepreciationSchedules.periodKey, currentPeriodKey),
        ),
      );

    const postedRuns = await this.db
      .select({ orgId: accDepreciationRuns.orgId, periodKey: accDepreciationRuns.periodKey })
      .from(accDepreciationRuns)
      .where(
        and(
          orgId ? eq(accDepreciationRuns.orgId, orgId) : undefined,
          eq(accDepreciationRuns.status, "POSTED"),
        ),
      );
    const postedSet = new Set(postedRuns.map((r) => `${r.orgId}:${r.periodKey}`));

    const toRun = duePeriods.filter((p) => !postedSet.has(`${p.orgId}:${p.periodKey}`));
    const results: Array<{ orgId: string; periodKey: string; runId?: number; error?: string }> = [];

    for (const { orgId: oId, periodKey } of toRun) {
      try {
        const systemUser = systemActor("finance.depreciation-run.execute", oId);
        const run = await this.runDepreciation(systemUser, periodKey);
        results.push({ orgId: oId, periodKey, runId: run?.id });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({ orgId: oId, periodKey, error: msg });
      }
    }

    return results;
  }
}
