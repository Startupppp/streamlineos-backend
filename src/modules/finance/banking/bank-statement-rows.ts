import type { CreateBankImportInput } from "./dto/imports.schemas";

/**
 * Turning a bank statement's raw cells into dated, signed amounts — and naming
 * every cell it cannot.
 *
 * Pure by construction: no database, no tenant, no audit. The statement dialects
 * (four date formats, an amount column or a debit/credit pair, thousands
 * separators) change with the banks a customer uses, while `ImportsService`
 * changes with how an import is stored, deduplicated and matched. Keeping the
 * dialects here means a new one can be added and checked without a database.
 */

export interface ParsedRow {
  date: string;
  description: string;
  amount: string;
  reference: string | null;
  counterparty: string | null;
}

export interface ImportRowError {
  row: number;
  errors: string[];
}

function normalizeDateToIso(raw: string, format: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fmtUp = format.toUpperCase();

  if (fmtUp === "YYYY-MM-DD" || fmtUp === "ISO") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    return null;
  }
  if (fmtUp === "DD/MM/YYYY") {
    const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
  }
  if (fmtUp === "MM/DD/YYYY") {
    const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[1]}-${m[2]}`;
  }
  if (fmtUp === "DD-MM-YYYY") {
    const m = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, "").trim();
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function parseBankStatementRows(
  rows: string[][],
  mapping: CreateBankImportInput["columnMapping"],
  dateFormat: string,
): { parsed: ParsedRow[]; errors: ImportRowError[] } {
  const parsed: ParsedRow[] = [];
  const errors: ImportRowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rowErrors: string[] = [];

    const rawDate = row[mapping.date] ?? "";
    const parsedDate = normalizeDateToIso(rawDate, dateFormat);
    if (!parsedDate) rowErrors.push(`Invalid date "${rawDate}" (expected format: ${dateFormat})`);

    const rawDesc = row[mapping.description] ?? "";

    let amountNum: number | null = null;
    if (mapping.amount !== undefined) {
      amountNum = parseAmount(row[mapping.amount] ?? "");
      if (amountNum === null) rowErrors.push(`Invalid amount "${row[mapping.amount]}"`);
    } else if (mapping.debit !== undefined && mapping.credit !== undefined) {
      const debitStr = row[mapping.debit] ?? "";
      const creditStr = row[mapping.credit] ?? "";
      const debit = parseAmount(debitStr) ?? 0;
      const credit = parseAmount(creditStr) ?? 0;
      if (debitStr && parseAmount(debitStr) === null) rowErrors.push(`Invalid debit "${debitStr}"`);
      if (creditStr && parseAmount(creditStr) === null) rowErrors.push(`Invalid credit "${creditStr}"`);
      amountNum = credit - debit;
    }

    if (rowErrors.length > 0) {
      errors.push({ row: i + 1, errors: rowErrors });
      continue;
    }

    const reference = mapping.reference !== undefined ? (row[mapping.reference] ?? null) : null;
    const counterparty = mapping.counterparty !== undefined ? (row[mapping.counterparty] ?? null) : null;

    parsed.push({
      date: parsedDate!,
      description: rawDesc || null!,
      amount: (amountNum ?? 0).toFixed(4),
      reference: reference?.trim() || null,
      counterparty: counterparty?.trim() || null,
    });
  }

  return { parsed, errors };
}
