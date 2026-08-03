import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { createHash } from "crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finBankAccounts,
  finBankImports,
  finBankTransactions,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { paginateOffset, buildListResponse } from "../../../common/pagination/pagination";
import { MatchingService } from "./matching.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateBankImportInput, BankImportsQuery } from "./dto/imports.schemas";

const MAX_IMPORT_ROWS = 2000;

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

function computeFingerprint(
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

@Injectable()
export class ImportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly matching: MatchingService,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
  ) {}

  async createImport(u: CurrentUserContext, input: CreateBankImportInput) {
    const { orgId, userId } = u;

    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(
        eq(finBankAccounts.id, input.bankAccountId),
        eq(finBankAccounts.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!account) throw new NotFoundException("Bank account not found");

    const dataRows = input.hasHeaderRow ? input.rows.slice(1) : input.rows;
    if (dataRows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(`Import exceeds maximum of ${MAX_IMPORT_ROWS} rows`);
    }

    const { parsed, errors } = this.parseRows(dataRows, input.columnMapping, input.dateFormat);

    if (errors.length > 0) {
      throw new BadRequestException({
        message: "Import contains invalid rows",
        rowErrors: errors,
      });
    }

    const [importRecord] = await this.db
      .insert(finBankImports)
      .values({
        orgId,
        bankAccountId: input.bankAccountId,
        fileName: input.fileName,
        format: "CSV",
        rowCount: parsed.length,
        importedCount: 0,
        duplicateCount: 0,
        status: "PENDING",
        columnMapping: input.columnMapping,
        createdBy: userId,
      })
      .returning();

    if (!importRecord) throw new Error("Failed to create import record");

    let importedCount = 0;
    let duplicateCount = 0;
    const newTransactionIds: number[] = [];

    for (const row of parsed) {
      const fingerprint = computeFingerprint(orgId, input.bankAccountId, row.date, row.amount, row.description ?? "");

      const [existing] = await this.db
        .select({ id: finBankTransactions.id })
        .from(finBankTransactions)
        .where(
          and(
            eq(finBankTransactions.orgId, orgId),
            eq(finBankTransactions.bankAccountId, input.bankAccountId),
            eq(finBankTransactions.fingerprint, fingerprint),
          ),
        )
        .limit(1);

      if (existing) {
        duplicateCount++;
        continue;
      }

      const [txn] = await this.db
        .insert(finBankTransactions)
        .values({
          orgId,
          bankAccountId: input.bankAccountId,
          importId: importRecord.id,
          txnDate: row.date,
          description: row.description,
          reference: row.reference,
          amount: row.amount,
          counterparty: row.counterparty,
          fingerprint,
          status: "UNMATCHED",
        })
        .returning({ id: finBankTransactions.id });

      if (txn) {
        newTransactionIds.push(txn.id);
        importedCount++;
      }
    }

    await this.db
      .update(finBankImports)
      .set({
        importedCount,
        duplicateCount,
        status: "COMPLETED",
      })
      .where(and(eq(finBankImports.id, importRecord.id), eq(finBankImports.orgId, orgId)));

    if (newTransactionIds.length > 0) {
      await this.matching.suggestMatches(u, input.bankAccountId, newTransactionIds);
    }

    void this.dispatch.emit({
      eventKey: "accounting.bank.import_completed",
      orgId,
      actorUserId: userId,
      targetUserIds: [userId],
      entityType: "bank_import",
      entityId: String(importRecord.id),
      variables: {
        fileName: input.fileName,
        importedCount,
        duplicateCount,
        totalRows: parsed.length,
      },
    });

    this.audit.log({
      action: "banking.import.complete",
      userId,
      orgId,
      resourceType: "bank_import",
      resourceId: String(importRecord.id),
      metadata: { importedCount, duplicateCount },
      result: "SUCCESS",
    });

    return { id: importRecord.id, importedCount, duplicateCount, totalRows: parsed.length };
  }

  async listImports(u: CurrentUserContext, query: BankImportsQuery) {
    const { orgId } = u;
    const { limit, offset } = paginateOffset(query);

    const conditions = [eq(finBankImports.orgId, orgId)];
    if (query.bankAccountId !== undefined) {
      conditions.push(eq(finBankImports.bankAccountId, query.bankAccountId));
    }

    const where = and(...conditions);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(finBankImports)
        .where(where)
        .orderBy(desc(finBankImports.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(finBankImports).where(where),
    ]);

    return buildListResponse(rows, totals?.total ?? 0, query);
  }

  private parseRows(
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
}
