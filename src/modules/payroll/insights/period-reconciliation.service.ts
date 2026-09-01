import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollBankBatchItems,
  payrollBankBatches,
  payrollJournalBatches,
} from "../../../db/schema";
import { findRunForMonth } from "./lib/report-builders";
import {
  evaluatePeriodReconciliation,
  type PeriodReconCheck,
} from "./lib/period-reconciliation";

export interface PeriodReconciliationReport {
  periodKey: string;
  mode: "export_manual";
  honestyNote: string;
  run: {
    id: number;
    status: string;
    netTotal: string;
    grossTotal: string;
    employeeCount: number | null;
  } | null;
  payout: {
    batchCount: number;
    totalPaid: string;
    totalPending: string;
    totalFailed: string;
    batches: {
      id: number;
      batchNumber: string;
      status: string;
      totalAmount: string;
      itemCount: number;
    }[];
  };
  journal: {
    batchId: number;
    version: number;
    status: string;
    reconciliationStatus: string;
    totalDebits: string;
    totalCredits: string;
    lineCount: number;
    provisional: boolean;
  } | null;
  checks: PeriodReconCheck[];
  overallOk: boolean;
  blockerCount: number;
  warningCount: number;
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Period-level recon across payroll run, bank payout items, and journal outbox.
 * Does not connect to bank statements or accounting GL providers.
 */
@Injectable()
export class PeriodReconciliationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getPeriodReconciliation(
    orgId: string,
    periodKey: string,
  ): Promise<PeriodReconciliationReport> {
    const run = await findRunForMonth(this.db, orgId, periodKey);

    let payoutBatches: {
      id: number;
      batchNumber: string;
      status: string;
      totalAmount: string;
      itemCount: number;
    }[] = [];
    let totalPaid = 0;
    let totalPending = 0;
    let totalFailed = 0;

    if (run) {
      payoutBatches = await this.db
        .select({
          id: payrollBankBatches.id,
          batchNumber: payrollBankBatches.batchNumber,
          status: payrollBankBatches.status,
          totalAmount: payrollBankBatches.totalAmount,
          itemCount: payrollBankBatches.itemCount,
        })
        .from(payrollBankBatches)
      .where(
          and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, run.id)),
        )
        .orderBy(desc(payrollBankBatches.createdAt))
        .limit(100);

      if (payoutBatches.length > 0) {
        const batchIds = payoutBatches.map((b) => b.id);
        const itemAgg = await this.db
          .select({
            status: payrollBankBatchItems.status,
            total: sql<string>`coalesce(sum(${payrollBankBatchItems.amount}), 0)::text`,
          })
          .from(payrollBankBatchItems)
          .where(
            and(
              eq(payrollBankBatchItems.orgId, orgId),
              inArray(payrollBankBatchItems.batchId, batchIds),
            ),
          )
          .groupBy(payrollBankBatchItems.status);

        for (const row of itemAgg) {
          const amt = parseFloat(row.total) || 0;
          if (row.status === "PAID") totalPaid += amt;
          else if (row.status === "FAILED") totalFailed += amt;
          else totalPending += amt; // PENDING, SENT, HELD, etc.
        }
      }
    }

    const journalRows = await this.db
      .select()
      .from(payrollJournalBatches)
      .where(
        and(
          eq(payrollJournalBatches.orgId, orgId),
          eq(payrollJournalBatches.periodKey, periodKey),
          ne(payrollJournalBatches.status, "REVERSED"),
        ),
      )
      .orderBy(desc(payrollJournalBatches.version))
      .limit(1);

    const journalRow = journalRows[0] ?? null;

    const evaluation = evaluatePeriodReconciliation({
      hasRun: run != null,
      runStatus: run?.status ?? null,
      runNet: run != null ? parseFloat(run.netTotal ?? "0") || 0 : null,
      hasPayoutBatch: payoutBatches.length > 0,
      payoutPaid: totalPaid,
      payoutPending: totalPending,
      payoutFailed: totalFailed,
      hasJournal: journalRow != null,
      journalDebits: journalRow != null ? parseFloat(journalRow.totalDebits) || 0 : null,
      journalCredits: journalRow != null ? parseFloat(journalRow.totalCredits) || 0 : null,
      journalStatus: journalRow?.status ?? null,
      journalReconStatus: journalRow?.reconciliationStatus ?? null,
    });

    return {
      periodKey,
      mode: "export_manual",
      honestyNote:
        "Reconciliation compares StreamlineOS run, payout, and journal outbox totals. Bank statement matching and GL provider posting are not automatic.",
      run: run
        ? {
            id: run.id,
            status: run.status,
            netTotal: run.netTotal ?? "0.00",
            grossTotal: run.grossTotal ?? "0.00",
            employeeCount: run.employeeCount ?? null,
          }
        : null,
      payout: {
        batchCount: payoutBatches.length,
        totalPaid: money(totalPaid),
        totalPending: money(totalPending),
        totalFailed: money(totalFailed),
        batches: payoutBatches.map((b) => ({
          id: b.id,
          batchNumber: b.batchNumber,
          status: b.status,
          totalAmount: b.totalAmount,
          itemCount: b.itemCount ?? 0,
        })),
      },
      journal: journalRow
        ? {
            batchId: journalRow.id,
            version: journalRow.version,
            status: journalRow.status,
            reconciliationStatus: journalRow.reconciliationStatus,
            totalDebits: journalRow.totalDebits,
            totalCredits: journalRow.totalCredits,
            lineCount: journalRow.lineCount,
            provisional: journalRow.provisional,
          }
        : null,
      checks: evaluation.checks,
      overallOk: evaluation.overallOk,
      blockerCount: evaluation.blockerCount,
      warningCount: evaluation.warningCount,
    };
  }
}
