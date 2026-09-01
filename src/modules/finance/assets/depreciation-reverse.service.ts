import {
  BadRequestException, Inject, Injectable, NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { JournalPostingService, type DraftLine } from "../../accounting/posting/journal-posting.service";
import {
  accFixedAssets, accDepreciationRuns, accDepreciationSchedules,
} from "../../../db/schema/accounting/finance-assets";
import { ledgerAccounts, journalLines } from "../../../db/schema/accounting/accounting";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class DepreciationReverseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly audit: AuditService,
  ) {}

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
}
