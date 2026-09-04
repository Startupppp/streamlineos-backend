import { NotFoundException } from "@nestjs/common";
import { and, count, eq, gte, lte, or } from "drizzle-orm";
import {
  accountingPeriods,
  journalEntries,
  purchaseBills,
  finBankTransactions,
  finApprovalRequests,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

/**
 * The period-close readiness probe: the four conditions that must hold before an
 * accounting period may be closed, each with the count that would explain a
 * failure.
 *
 * It reaches across the whole finance module — journals, purchase bills, bank
 * transactions and approval requests — while `PeriodsService` otherwise touches
 * only `accounting_periods` and its cache. That join set grows every time
 * finance gains a document type, so it is kept apart from the period lifecycle.
 */
export async function loadPeriodCloseChecklist(db: Db, orgId: string, periodId: number) {
  const period = await db
    .select()
    .from(accountingPeriods)
    .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
    .limit(1);
  if (!period[0]) throw new NotFoundException("Period not found");

  const { startDate, endDate } = period[0];

  const [draftJournalRows, draftBillRows, unreconciledRows, pendingRows] =
    await Promise.all([
      db
        .select({ c: count() })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            gte(journalEntries.entryDate, startDate),
            lte(journalEntries.entryDate, endDate),
            or(
              eq(journalEntries.status, "DRAFT"),
              eq(journalEntries.status, "PENDING_APPROVAL"),
            ),
          ),
        ),
      db
        .select({ c: count() })
        .from(purchaseBills)
        .where(
          and(
            eq(purchaseBills.orgId, orgId),
            gte(purchaseBills.billDate, startDate),
            lte(purchaseBills.billDate, endDate),
            eq(purchaseBills.status, "DRAFT"),
          ),
        ),
      db
        .select({ c: count() })
        .from(finBankTransactions)
        .where(
          and(
            eq(finBankTransactions.orgId, orgId),
            gte(finBankTransactions.txnDate, startDate),
            lte(finBankTransactions.txnDate, endDate),
            or(
              eq(finBankTransactions.status, "UNMATCHED"),
              eq(finBankTransactions.status, "SUGGESTED"),
            ),
          ),
        ),
      db
        .select({ c: count() })
        .from(finApprovalRequests)
        .where(
          and(
            eq(finApprovalRequests.orgId, orgId),
            eq(finApprovalRequests.status, "PENDING"),
          ),
        ),
    ]);

  const [draftJournals] = draftJournalRows;
  const [draftBills] = draftBillRows;
  const [unreconciledTxns] = unreconciledRows;
  const [pendingApprovals] = pendingRows;

  const draftJournalCount = Number(draftJournals?.c ?? 0);
  const draftBillCount = Number(draftBills?.c ?? 0);
  const unreconciledCount = Number(unreconciledTxns?.c ?? 0);
  const pendingApprovalCount = Number(pendingApprovals?.c ?? 0);

  return {
    period: period[0],
    checklist: {
      noDraftJournals: { passed: draftJournalCount === 0, count: draftJournalCount },
      noDraftBills: { passed: draftBillCount === 0, count: draftBillCount },
      noUnreconciledTransactions: { passed: unreconciledCount === 0, count: unreconciledCount },
      noPendingApprovals: { passed: pendingApprovalCount === 0, count: pendingApprovalCount },
    },
    canClose:
      draftJournalCount === 0 &&
      draftBillCount === 0 &&
      unreconciledCount === 0 &&
      pendingApprovalCount === 0,
  };
}
