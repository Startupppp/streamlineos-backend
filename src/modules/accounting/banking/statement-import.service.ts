/**
 * Statement import (PRD 04 S1).
 *
 * The importer's whole job is to turn somebody's export into rows that can be
 * argued with. Three rules make that possible:
 *
 * 1. **The date format is declared.** `03/04/2026` is 3 April under DD/MM and
 *    4 March under MM/DD; an importer that guesses moves money between months.
 * 2. **The same file cannot land twice.** The SHA-256 of the raw bytes is
 *    stored, and `uniq_bank_statements_profile_hash` is what actually enforces
 *    it — the pre-check in lib/statement-import-write.ts is only there to give
 *    a decent message.
 * 3. **`opening + movements = closing`, or nothing is written.** A file that
 *    does not tie is a file somebody edited in a spreadsheet, and importing it
 *    would poison every reconciliation built on top.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { bankStatementLines, bankStatements } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../kernel/sequence.service";
import { compareDates } from "../kernel/fiscal-calendar";
import { money, sum } from "../kernel/money";
import { BankAccountsService } from "./bank-accounts.service";
import { STATEMENT_MAPPING_PRESETS, type StatementMappingPreset } from "./csv-presets";
import {
  assertTies,
  collectWarnings,
  isoOrReject,
  parseStatementOrReject,
  requireAmount,
  resolveMapping,
} from "./lib/statement-import-rules";
import { assertNotAlreadyImported, insertStatementWithLines } from "./lib/statement-import-write";
import type {
  ImportedStatementLine,
  ImportStatementInput,
  StatementImportResult,
  StatementSummary,
} from "./statement-import.types";

/*
  The import flow and the read paths stay here. The checks that turn a bad file
  into a 400 are in lib/statement-import-rules.ts; the duplicate-file check and
  the two inserts are in lib/statement-import-write.ts.
*/
export type {
  ImportedStatementLine,
  ImportStatementInput,
  ImportWarning,
  ImportWarningCode,
  StatementImportResult,
  StatementSummary,
} from "./statement-import.types";

@Injectable()
export class StatementImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly bankAccounts: BankAccountsService,
  ) {}

  /** The shipped layouts, as data a UI can list. */
  listPresets(): readonly StatementMappingPreset[] {
    return STATEMENT_MAPPING_PRESETS;
  }

  /* --------------------------------------------------------------- import */

  async import(
    orgId: string,
    userId: string | null,
    input: ImportStatementInput,
  ): Promise<StatementImportResult> {
    const profile = await this.bankAccounts.get(orgId, input.bankProfileId);
    const currency = profile.currency;

    const periodStart = isoOrReject(input.periodStart, "periodStart");
    const periodEnd = isoOrReject(input.periodEnd, "periodEnd");
    if (compareDates(periodEnd, periodStart) < 0) {
      throw new BadRequestException("The statement period ends before it starts");
    }

    if (typeof input.content !== "string" || input.content.trim() === "") {
      throw new BadRequestException("The statement file is empty");
    }

    // Hash the bytes as supplied, before any normalisation — the point is that
    // the *same export* cannot be imported twice.
    const fileHash = createHash("sha256").update(input.content, "utf8").digest("hex");
    await assertNotAlreadyImported(this.db, orgId, profile.id, fileHash);

    const mapping = resolveMapping(profile.csvMapping, input.presetCode, input.mapping);
    const openingMinor = requireAmount(input.opening, currency, "opening");
    const closingMinor = requireAmount(input.closing, currency, "closing");

    const parsed = parseStatementOrReject(input.content, mapping, currency);

    if (parsed.rows.length === 0) {
      throw new BadRequestException(
        "The file produced no statement lines. Check the column mapping and the number of rows skipped.",
      );
    }

    const movementMinor = sum(
      parsed.rows.map((r) => money(r.amountMinor, currency)),
      currency,
    ).minor;

    assertTies(openingMinor, movementMinor, closingMinor, currency, parsed.rows.length);

    const warnings = collectWarnings(parsed, periodStart, periodEnd, currency);

    const inserted = await this.db.transaction(async (tx) =>
      insertStatementWithLines(tx, {
        orgId,
        userId,
        profile,
        periodStart,
        periodEnd,
        openingMinor,
        closingMinor,
        currency,
        fileHash,
        fileName: input.fileName,
        lines: parsed.rows,
      }),
    );

    return {
      statementId: inserted.statementId,
      bankProfileId: profile.id,
      currency,
      periodStart,
      periodEnd,
      openingMinor,
      closingMinor,
      movementMinor,
      lineCount: inserted.rows.length,
      fileHash,
      warnings,
      lines: inserted.rows
        .map((r) => ({ ...r, amountMinor: Number(r.amountMinor) }))
        .sort((a, b) => a.lineNo - b.lineNo),
    };
  }

  /* ----------------------------------------------------------- read paths */

  async listStatements(
    orgId: string,
    query: { bankProfileId?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ items: StatementSummary[]; page: number; pageSize: number; total: number }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));

    const conditions = [eq(bankStatements.orgId, orgId)];
    if (query.bankProfileId) conditions.push(eq(bankStatements.bankProfileId, query.bankProfileId));

    const rows = await this.db
      .select({
        id: bankStatements.id,
        bankProfileId: bankStatements.bankProfileId,
        bookId: bankStatements.bookId,
        currency: bankStatements.currency,
        periodStart: bankStatements.periodStart,
        periodEnd: bankStatements.periodEnd,
        openingMinor: bankStatements.openingMinor,
        closingMinor: bankStatements.closingMinor,
        source: bankStatements.source,
        fileName: bankStatements.fileName,
        fileHash: bankStatements.fileHash,
        reconciledAt: bankStatements.reconciledAt,
        reconciledBy: bankStatements.reconciledBy,
        importedAt: bankStatements.importedAt,
        lineCount: sql<number>`(
          select count(*) from ${bankStatementLines}
          where ${bankStatementLines.statementId} = ${bankStatements.id}
        )::int`,
        total: sql<number>`count(*) over ()`,
      })
      .from(bankStatements)
      .where(and(...conditions))
      .orderBy(desc(bankStatements.periodEnd), desc(bankStatements.importedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map(({ total: _total, ...r }) => ({
        ...r,
        openingMinor: Number(r.openingMinor),
        closingMinor: Number(r.closingMinor),
        lineCount: Number(r.lineCount),
      })),
      page,
      pageSize,
      total: rows.length > 0 ? Number(rows[0].total) : 0,
    };
  }

  async requireStatement(
    orgId: string,
    statementId: string,
    tx: DbOrTx = this.db,
  ): Promise<StatementSummary> {
    const [row] = await tx
      .select({
        id: bankStatements.id,
        bankProfileId: bankStatements.bankProfileId,
        bookId: bankStatements.bookId,
        currency: bankStatements.currency,
        periodStart: bankStatements.periodStart,
        periodEnd: bankStatements.periodEnd,
        openingMinor: bankStatements.openingMinor,
        closingMinor: bankStatements.closingMinor,
        source: bankStatements.source,
        fileName: bankStatements.fileName,
        fileHash: bankStatements.fileHash,
        reconciledAt: bankStatements.reconciledAt,
        reconciledBy: bankStatements.reconciledBy,
        importedAt: bankStatements.importedAt,
        lineCount: sql<number>`(
          select count(*) from ${bankStatementLines}
          where ${bankStatementLines.statementId} = ${bankStatements.id}
        )::int`,
      })
      .from(bankStatements)
      .where(and(eq(bankStatements.orgId, orgId), eq(bankStatements.id, statementId)))
      .limit(1);

    if (!row) throw new NotFoundException("Bank statement not found");
    return {
      ...row,
      openingMinor: Number(row.openingMinor),
      closingMinor: Number(row.closingMinor),
      lineCount: Number(row.lineCount),
    };
  }

  async getStatement(
    orgId: string,
    statementId: string,
    query: { page?: number; pageSize?: number } = {},
  ): Promise<StatementSummary & { lines: ImportedStatementLine[]; page: number; pageSize: number }> {
    const statement = await this.requireStatement(orgId, statementId);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 100));

    const lines = await this.db
      .select({
        id: bankStatementLines.id,
        lineNo: bankStatementLines.lineNo,
        valueDate: bankStatementLines.valueDate,
        amountMinor: bankStatementLines.amountMinor,
        description: bankStatementLines.description,
        bankReference: bankStatementLines.bankReference,
      })
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.orgId, orgId),
          eq(bankStatementLines.statementId, statementId),
        ),
      )
      .orderBy(asc(bankStatementLines.lineNo))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      ...statement,
      page,
      pageSize,
      lines: lines.map((l) => ({ ...l, amountMinor: Number(l.amountMinor) })),
    };
  }
}
