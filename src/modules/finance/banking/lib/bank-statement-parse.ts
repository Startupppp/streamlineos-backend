import { createHash } from "crypto";
import type { CreateBankImportInput } from "../dto/imports.schemas";

/**
 * Reading a bank statement file: dates, amounts, and the fingerprint that makes
 * a re-upload a no-op.
 *
 * Pure, and split out for that reason — it takes rows of strings and returns
 * rows or errors, touching no database and no services. It is also the half with
 * the format decisions in it: four accepted date layouts, a thousands-separator
 * strip on amounts, and a fingerprint over
 * `(org, account, date, amount, normalised description)` which is what lets the
 * same statement be uploaded twice without duplicating transactions.
 */

export const MAX_IMPORT_ROWS = 2000;

interface ParsedRow {
  date: string;
  description: string;
  amount: string;
  reference: string | null;
  counterparty: string | null;
}

interface ImportRowError {
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

export function computeFingerprint(
  orgId: string,
  bankAccountId: number,
  date: string,
  amount: string,
  description: string,
): string {
  const normalized = description.trim().toLowerCase().replace(/\s+/g, " ");
  const payload = `${orgId}|${bankAccountId}|${date}|${amount}|${normalized}`;
  return createHash("sha256").update(payload).digest("hex");
}

export function parseRows(
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
