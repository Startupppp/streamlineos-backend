import { NotFoundException } from "@nestjs/common";
import { and, count, eq, gte, lte, or } from "drizzle-orm";
import {
  accountingPeriods,
  journalEntries,
  purchaseBills,
  finBankTransactions,
  finApprovalRequests,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";

/**
 * What has to be true before an accounting period can be closed.
 *
 * Split from the period lifecycle next door because it is the only part that
 * reaches OUTSIDE the general ledger: it counts unposted journals, unapproved
 * bills, unreconciled bank transactions and pending approvals, which is four
 * other modules' state read for one decision. The lifecycle itself — generate,
 * close, lock, reopen — touches `accounting_periods` and nothing else.
 *
 * A plain `db` parameter rather than a deps bag: it reads and reports, and
 * writes nothing.
 */

export async function getCloseChecklist(
  db: Db,
 orgId: string, periodId: number) {
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
