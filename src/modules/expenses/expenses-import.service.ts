import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { expenses } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../common/organization/organization-actor";
import { compareDecimals, isZero, toDecimal } from "../accounting/core/money.util";
import type { ImportInput } from "./dto/expense-import.schemas";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const BATCH_SIZE = 500;

const ALLOWED_CATEGORIES = new Set([
  "Travel",
  "Food",
  "Office Supplies",
  "Software",
  "Hardware",
  "Marketing",
  "Entertainment",
  "Utilities",
  "Rent",
  "Insurance",
  "Salary",
  "Miscellaneous",
  "Other",
]);

interface ParsedImportRow {
  rowNumber: number;
  record: Record<string, string>;
}

function sanitizeCell(value: string): string {
  return value.replace(/^[=+\-@\t\r]+/, "").trim();
}

function normalizeHeader(header: string): string {
  return sanitizeCell(String(header)).toLowerCase().replace(/[\s_-]+/g, "");
}

const IMPORT_AMOUNT_SHAPE = /^\d{1,12}(\.\d{1,2})?$/;
const MAX_IMPORT_AMOUNT = "100000000";

/**
 * `parseFloat` reads "1,234.50" as 1 and "1.2.3" as 1.2 without complaining, so a
 * thousands-separated or malformed cell used to import as a silently wrong amount rather
 * than a skipped row. Only a clean decimal, with the separators stripped first, is accepted.
 */
function parseImportAmount(raw: string): string | null {
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!IMPORT_AMOUNT_SHAPE.test(cleaned)) return null;
  const amount = toDecimal(cleaned);
  if (isZero(amount)) return null;
  if (compareDecimals(amount, MAX_IMPORT_AMOUNT) > 0) return null;
  return amount;
}

function normalizeDate(value: string): string {
  const cleaned = sanitizeCell(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0];
  return new Date().toISOString().split("T")[0];
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((v) => v.replace(/^["']|["']$/g, ""));
}

function readCsvRows(content: string): ParsedImportRow[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => normalizeHeader(h));
  const rows = lines.slice(1, MAX_ROWS + 1);
  return rows.map((line, idx) => {
    const values = parseCsvLine(line);
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = sanitizeCell(values[i] || "");
    });
    return { rowNumber: idx + 2, record };
  });
}

@Injectable()
export class ExpensesImportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async importExpenses(orgId: string, userId: string, input: ImportInput) {
    const autoApprove = input.autoApprove === true || input.autoApprove === "true";

    let importerMembershipId: number | null = null;
    if (autoApprove) {
      const actor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
        if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
        throw e;
      });
      importerMembershipId = actor.membershipId;
    }

    if (Buffer.byteLength(input.content, "utf8") > MAX_FILE_SIZE) {
      throw new BadRequestException("File too large (max 5MB)");
    }

    const lowerName = input.fileName.toLowerCase();
    if (lowerName.endsWith(".xlsx")) {
      throw new BadRequestException("XLSX import is not supported; please upload a CSV file");
    }

    const rows = readCsvRows(input.content);
    if (rows.length === 0) {
      throw new BadRequestException("File must contain a header row and at least one data row");
    }

    const batchValues: (typeof expenses.$inferInsert)[] = [];
    let skipped = 0;
    const skippedReasons: Array<{ row: number; reason: string }> = [];

    for (const parsedRow of rows) {
      const { rowNumber, record } = parsedRow;
      const rawCategory = sanitizeCell(record.category || "Other");
      const category = ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : "Other";
      const amount = parseImportAmount(record.amount ?? "");
      if (amount === null) {
        skipped++;
        skippedReasons.push({
          row: rowNumber,
          reason: "Invalid amount (must be a positive number up to 100000000)",
        });
        continue;
      }

      const description = sanitizeCell(record.description || "");
      const merchant = sanitizeCell(record.merchant || "");
      const paymentMethod = sanitizeCell(
        record.paymentmethod || record["payment_method"] || record["payment method"] || "",
      );
      const expenseDate = record.expensedate || record.date || "";
      const validDate = normalizeDate(expenseDate);

      batchValues.push({
        orgId,
        userId,
        category,
        amount,
        description: description.slice(0, 500),
        merchant: merchant.slice(0, 200),
        paymentMethod: paymentMethod || null,
        expenseDate: validDate,
        status: autoApprove ? "APPROVED" : "PENDING",
        approverId: autoApprove ? userId : null,
        approverMembershipId: autoApprove ? importerMembershipId : null,
        approvedAt: autoApprove ? new Date() : null,
      });
    }

    if (batchValues.length > 0) {
      for (let i = 0; i < batchValues.length; i += BATCH_SIZE) {
        await this.db.insert(expenses).values(batchValues.slice(i, i + BATCH_SIZE));
      }
    }

    return {
      success: true,
      count: batchValues.length,
      skipped,
      skippedReasons,
      ...(rows.length >= MAX_ROWS ? { warning: `Only first ${MAX_ROWS} rows were processed` } : {}),
    };
  }
}
