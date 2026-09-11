import { payrollJournalBatchLines, payrollJournalBatches } from "../../../db/schema";

export type JournalBatchStatus = "DRAFT" | "POSTED" | "EXPORTED" | "REVERSED" | "FAILED";
export type JournalReconStatus = "UNRECONCILED" | "RECONCILED" | "DISPUTED";

export interface JournalBatchSummary {
  id: number;
  periodKey: string;
  version: number;
  status: JournalBatchStatus;
  reconciliationStatus: JournalReconStatus;
  reversalOfBatchId: number | null;
  provisional: boolean;
  totalDebits: string;
  totalCredits: string;
  lineCount: number;
  unmappedCodes: string[];
  runId: number | null;
  note: string | null;
  reversalReason: string | null;
  reconciliationNote: string | null;
  postedAt: Date | null;
  exportedAt: Date | null;
  reversedAt: Date | null;
  reconciledAt: Date | null;
  createdAt: Date;
}

export interface JournalBatchDetail extends JournalBatchSummary {
  lines: JournalBatchLine[];
}

interface JournalBatchLine {
  lineNo: number;
  account: string;
  description: string;
  debit: string;
  credit: string;
  costCenter: string | null;
}

export const journalBatchSummarySelection = {
  id: payrollJournalBatches.id,
  periodKey: payrollJournalBatches.periodKey,
  version: payrollJournalBatches.version,
  status: payrollJournalBatches.status,
  reconciliationStatus: payrollJournalBatches.reconciliationStatus,
  reversalOfBatchId: payrollJournalBatches.reversalOfBatchId,
  provisional: payrollJournalBatches.provisional,
  totalDebits: payrollJournalBatches.totalDebits,
  totalCredits: payrollJournalBatches.totalCredits,
  lineCount: payrollJournalBatches.lineCount,
  unmappedCodes: payrollJournalBatches.unmappedCodes,
  runId: payrollJournalBatches.runId,
  note: payrollJournalBatches.note,
  reversalReason: payrollJournalBatches.reversalReason,
  reconciliationNote: payrollJournalBatches.reconciliationNote,
  postedAt: payrollJournalBatches.postedAt,
  exportedAt: payrollJournalBatches.exportedAt,
  reversedAt: payrollJournalBatches.reversedAt,
  reconciledAt: payrollJournalBatches.reconciledAt,
  createdAt: payrollJournalBatches.createdAt,
};

export const journalBatchLineSelection = {
  lineNo: payrollJournalBatchLines.lineNo,
  account: payrollJournalBatchLines.account,
  description: payrollJournalBatchLines.description,
  debit: payrollJournalBatchLines.debit,
  credit: payrollJournalBatchLines.credit,
  costCenter: payrollJournalBatchLines.costCenter,
};

type JournalBatchSummaryRow = Pick<
  typeof payrollJournalBatches.$inferSelect,
  | "id"
  | "periodKey"
  | "version"
  | "status"
  | "reconciliationStatus"
  | "reversalOfBatchId"
  | "provisional"
  | "totalDebits"
  | "totalCredits"
  | "lineCount"
  | "unmappedCodes"
  | "runId"
  | "note"
  | "reversalReason"
  | "reconciliationNote"
  | "postedAt"
  | "exportedAt"
  | "reversedAt"
  | "reconciledAt"
  | "createdAt"
>;

export function toJournalBatchSummary(row: JournalBatchSummaryRow): JournalBatchSummary {
  return {
    id: row.id,
    periodKey: row.periodKey,
    version: row.version,
    status: row.status,
    reconciliationStatus: row.reconciliationStatus,
    reversalOfBatchId: row.reversalOfBatchId,
    provisional: row.provisional,
    totalDebits: row.totalDebits,
    totalCredits: row.totalCredits,
    lineCount: row.lineCount,
    unmappedCodes: row.unmappedCodes ?? [],
    runId: row.runId,
    note: row.note,
    reversalReason: row.reversalReason,
    reconciliationNote: row.reconciliationNote,
    postedAt: row.postedAt,
    exportedAt: row.exportedAt,
    reversedAt: row.reversedAt,
    reconciledAt: row.reconciledAt,
    createdAt: row.createdAt,
  };
}
