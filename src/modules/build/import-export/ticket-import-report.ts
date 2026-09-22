import type { ImportFormat } from "./import-source";
import type { ImportRowIssue, TicketImportPreview } from "./ticket-import-preview";

export type ImportMode = "atomic" | "partial";

type ImportRowOutcome = "IMPORTED" | "SKIPPED" | "FAILED" | "ROLLED_BACK";

export interface ImportRowResult {
  rowNumber: number;
  outcome: ImportRowOutcome;
  ticketId: number | null;
  message: string | null;
}

export interface ImportReportSummary {
  attempted: number;
  imported: number;
  skipped: number;
  failed: number;
  rolledBack: number;
}

export interface TicketImportReport {
  projectId: number;
  format: ImportFormat;
  mode: ImportMode;
  idempotencyKey: string | null;
  replayed: boolean;
  confirmationToken: string;
  summary: ImportReportSummary;
  rows: ImportRowResult[];
  issues: ImportRowIssue[];
}

export function skippedRows(preview: TicketImportPreview): ImportRowResult[] {
  const byRow = new Map<number, ImportRowIssue>();
  for (const issue of preview.issues) if (!byRow.has(issue.rowNumber)) byRow.set(issue.rowNumber, issue);
  return [...byRow.values()].map((issue) => ({
    rowNumber: issue.rowNumber,
    outcome: "SKIPPED" as const,
    ticketId: null,
    message: issue.message,
  }));
}

export function summarize(rows: readonly ImportRowResult[]): ImportReportSummary {
  const count = (outcome: ImportRowOutcome) =>
    rows.filter((row) => row.outcome === outcome).length;
  return {
    attempted: rows.length,
    imported: count("IMPORTED"),
    skipped: count("SKIPPED"),
    failed: count("FAILED"),
    rolledBack: count("ROLLED_BACK"),
  };
}
