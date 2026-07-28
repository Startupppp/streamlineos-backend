import {
  BadRequestException, Inject, Injectable, NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { JournalPostingService, type DraftLine } from "../accounting/journal-posting.service";
import { paginateOffset, buildListResponse } from "../../common/pagination/pagination";
import {
  accFixedAssets, accAssetCategories, accDepreciationRuns, accDepreciationSchedules,
} from "../../db/schema/accounting/finance-assets";
import { ledgerAccounts, journalLines } from "../../db/schema/accounting/accounting";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { ListRunsQuery } from "./dto/assets.schemas";

@Injectable()
export class DepreciationRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async list(orgId: string, query: ListRunsQuery) {
    const { limit, offset } = paginateOffset(query);
    const where = eq(accDepreciationRuns.orgId, orgId);
    const [items, totals] = await Promise.all([
      this.db
        .select()
        .from(accDepreciationRuns)
        .where(where)
        .orderBy(desc(accDepreciationRuns.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ c: count() }).from(accDepreciationRuns).where(where),
    ]);
    return buildListResponse(items, Number(totals[0]?.c ?? 0), query);
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

    const categoryAmounts = new Map<number, {
      depExpAccountId: number;
      accumDepAccountId: number;
      total: number;
      scheduleIds: number[];
    }>();

    for (const row of scheduleRows) {
      const catId = row.category.id;
      const entry = categoryAmounts.get(catId);
      const amount = Number(row.schedule.amount);
      if (entry) {
        entry.total += amount;
        entry.scheduleIds.push(row.schedule.id);
      } else {
        categoryAmounts.set(catId, {
          depExpAccountId: row.category.depreciationExpenseAccountId,
          accumDepAccountId: row.category.accumulatedDepreciationAccountId,
          total: amount,
          scheduleIds: [row.schedule.id],
        });
      }
    }

    const allAccountIds = Array.from(categoryAmounts.values()).flatMap((c) => [
      c.depExpAccountId,
      c.accumDepAccountId,
    ]);
    const accountRows = await this.db
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(inArray(ledgerAccounts.id, [...new Set(allAccountIds)]), eq(ledgerAccounts.orgId, u.orgId)));
    const codeMap = new Map(accountRows.map((a) => [a.id, a.code]));

    const lines: DraftLine[] = [];
    let totalAmount = 0;

    for (const cat of categoryAmounts.values()) {
      const depExpCode = codeMap.get(cat.depExpAccountId);
      const accumDepCode = codeMap.get(cat.accumDepAccountId);
      if (!depExpCode || !accumDepCode) {
        throw new UnprocessableEntityException(
          "Depreciation expense or accumulated depreciation account not found in CoA",
        );
      }
      const amt = Math.round(cat.total * 10000) / 10000;
      totalAmount += amt;
      lines.push({
        accountCode: depExpCode,
        debit: amt,
        credit: 0,
        description: `Depreciation for ${periodKey}`,
      });
      lines.push({
        accountCode: accumDepCode,
        debit: 0,
        credit: amt,
        description: `Accumulated depreciation for ${periodKey}`,
      });
    }

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

    const roundedTotal = Math.round(totalAmount * 10000) / 10000;

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
        .where(inArray(accDepreciationSchedules.id, allScheduleIds));

      const assetAmounts = new Map<number, number>();
      for (const row of scheduleRows) {
        const prev = assetAmounts.get(row.asset.id) ?? 0;
        assetAmounts.set(row.asset.id, prev + Number(row.schedule.amount));
      }

      for (const [assetId, amt] of assetAmounts) {
        const asset = scheduleRows.find((r) => r.asset.id === assetId)?.asset;
        if (!asset) continue;
        const newAccum = Math.round((Number(asset.accumulatedDepreciation) + amt) * 10000) / 10000;
        const depreciable = Number(asset.acquisitionCost) - Number(asset.salvageValue);
        const newStatus = newAccum >= depreciable - 0.0001 ? "FULLY_DEPRECIATED" : "ACTIVE";
        await tx
          .update(accFixedAssets)
          .set({ accumulatedDepreciation: String(newAccum), status: newStatus, updatedAt: new Date() })
          .where(eq(accFixedAssets.id, assetId));
      }

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

    await this.cache.invalidatePattern(`fin:assets:list:${u.orgId}:*`);
    return run;
  }

  async reverseRun(u: CurrentUserContext, runId: number) {
    const [run] = await this.db
      .select()
      .from(accDepreciationRuns)
      .where(and(eq(accDepreciationRuns.id, runId), eq(accDepreciationRuns.orgId, u.orgId)))
      .limit(1);
    if (!run) throw new NotFoundException(`Depreciation run ${runId} not found`);
    if (run.status !== "POSTED") throw new BadRequestException("Only POSTED runs can be reversed");
    if (!run.journalEntryId) throw new BadRequestException("Run has no linked journal entry");

    const originalLines = await this.db
      .select({
        accountCode: ledgerAccounts.code,
        debit: journalLines.debit,
        credit: journalLines.credit,
        description: journalLines.description,
        lineOrder: journalLines.lineOrder,
      })
      .from(journalLines)
      .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
      .where(and(eq(journalLines.entryId, run.journalEntryId), eq(journalLines.orgId, u.orgId)))
      .orderBy(journalLines.lineOrder);

    const reversalLines: DraftLine[] = originalLines.map((l) => ({
      accountCode: l.accountCode,
      debit: Number(l.credit),
      credit: Number(l.debit),
      description: l.description ?? undefined,
    }));

    const reversalEntry = await this.posting.persistJournalEntry({
      orgId: u.orgId,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Reversal of depreciation run ${run.periodKey}`,
      sourceType: "DEPRECIATION_RUN",
      sourceId: run.periodKey,
      sourceEvent: "reverse",
      createdBy: u.userId,
      lines: reversalLines,
    });

    await this.db.transaction(async (tx) => {
      const scheduleRows = await tx
        .select({ assetId: accDepreciationSchedules.assetId, amount: accDepreciationSchedules.amount })
        .from(accDepreciationSchedules)
        .where(and(eq(accDepreciationSchedules.runId, runId), eq(accDepreciationSchedules.orgId, u.orgId)));

      await tx
        .update(accDepreciationSchedules)
        .set({ status: "SCHEDULED", runId: null, journalEntryId: null })
        .where(and(eq(accDepreciationSchedules.runId, runId), eq(accDepreciationSchedules.orgId, u.orgId)));

      const assetAmounts = new Map<number, number>();
      for (const row of scheduleRows) {
        const prev = assetAmounts.get(row.assetId) ?? 0;
        assetAmounts.set(row.assetId, prev + Number(row.amount));
      }

      for (const [assetId, amt] of assetAmounts) {
        const [asset] = await tx
          .select()
          .from(accFixedAssets)
          .where(and(eq(accFixedAssets.id, assetId), eq(accFixedAssets.orgId, u.orgId)))
          .limit(1);
        if (!asset) continue;
        const newAccum = Math.max(
          0,
          Math.round((Number(asset.accumulatedDepreciation) - amt) * 10000) / 10000,
        );
        const newStatus = asset.status === "FULLY_DEPRECIATED" ? "ACTIVE" : asset.status;
        await tx
          .update(accFixedAssets)
          .set({ accumulatedDepreciation: String(newAccum), status: newStatus, updatedAt: new Date() })
          .where(and(eq(accFixedAssets.id, assetId), eq(accFixedAssets.orgId, u.orgId)));
      }

      await tx
        .update(accDepreciationRuns)
        .set({ status: "DRAFT" })
        .where(and(eq(accDepreciationRuns.id, runId), eq(accDepreciationRuns.orgId, u.orgId)));
    });

    this.audit.log({
      action: "REVERSE",
      orgId: u.orgId,
      userId: u.userId,
      resourceType: "depreciation_run",
      resourceId: String(runId),
    });

    return { runId, reversalEntryId: reversalEntry.id, reversalEntryNumber: reversalEntry.entryNumber };
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
        const systemUser: CurrentUserContext = {
          userId: "system",
          orgId: oId,
          branchId: null,
          role: "SYSTEM",
          permissions: [],
          enabledModules: [],
          plan: null,
          isPlatformAdmin: false,
          isOrgOwner: false,
          sessionId: "cron",
        };
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
