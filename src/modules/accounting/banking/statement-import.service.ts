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
 *    it — the pre-check below is only there to give a decent message.
 * 3. **`opening + movements = closing`, or nothing is written.** A file that
 *    does not tie is a file somebody edited in a spreadsheet, and importing it
 *    would poison every reconciliation built on top.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { bankStatementLines, bankStatements } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../kernel/sequence.service";
import { assertIsoDate, compareDates } from "../kernel/fiscal-calendar";
import { money, sum, toDecimalString } from "../kernel/money";
import { BankAccountsService } from "./bank-accounts.service";
import { findMappingPreset, STATEMENT_MAPPING_PRESETS, type StatementMappingPreset } from "./csv-presets";
import {
  assertMappingIsUsable,
  findDuplicateLines,
  parseAmountToMinor,
  parseStatementCsv,
  StatementCsvError,
  type LooseColumnMapping,
  type StatementColumnMapping,
} from "./statement-csv";
import { isUniqueViolation } from "./pg-errors";

export type ImportWarningCode =
  | "DUPLICATE_LINE"
  | "ROW_SKIPPED"
  | "LINE_OUTSIDE_PERIOD";

export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ImportStatementInput {
  bankProfileId: string;
  /** The raw file, as a string. No multipart, no upload dependency. */
  content: string;
  fileName?: string;
  /** A named layout, an explicit mapping, or neither (falls back to the saved one). */
  presetCode?: string;
  mapping?: Partial<StatementColumnMapping>;
  periodStart: string;
  periodEnd: string;
  /** Decimal strings in the bank account's currency, e.g. `"10000.00"`. */
  opening: string;
  closing: string;
}

export interface ImportedStatementLine {
  id: string;
  lineNo: number;
  valueDate: string;
  amountMinor: number;
  description: string | null;
  bankReference: string | null;
}

export interface StatementImportResult {
  statementId: string;
  bankProfileId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  openingMinor: number;
  closingMinor: number;
  movementMinor: number;
  lineCount: number;
  fileHash: string;
  warnings: ImportWarning[];
  lines: ImportedStatementLine[];
}

export interface StatementSummary {
  id: string;
  bankProfileId: string;
  bookId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  openingMinor: number;
  closingMinor: number;
  source: "csv" | "manual" | "feed";
  fileName: string | null;
  fileHash: string | null;
  lineCount: number;
  reconciledAt: Date | null;
  reconciledBy: string | null;
  importedAt: Date;
}

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

    const periodStart = this.isoOrReject(input.periodStart, "periodStart");
    const periodEnd = this.isoOrReject(input.periodEnd, "periodEnd");
    if (compareDates(periodEnd, periodStart) < 0) {
      throw new BadRequestException("The statement period ends before it starts");
    }

    if (typeof input.content !== "string" || input.content.trim() === "") {
      throw new BadRequestException("The statement file is empty");
    }

    // Hash the bytes as supplied, before any normalisation — the point is that
    // the *same export* cannot be imported twice.
    const fileHash = createHash("sha256").update(input.content, "utf8").digest("hex");
    await this.assertNotAlreadyImported(orgId, profile.id, fileHash);

    const mapping = this.resolveMapping(profile.csvMapping, input.presetCode, input.mapping);
    const openingMinor = this.requireAmount(input.opening, currency, "opening");
    const closingMinor = this.requireAmount(input.closing, currency, "closing");

    const parsed = (() => {
      try {
        return parseStatementCsv(input.content, mapping, currency);
      } catch (error) {
        if (error instanceof StatementCsvError) throw new BadRequestException(error.message);
        throw error;
      }
    })();

    if (parsed.rows.length === 0) {
      throw new BadRequestException(
        "The file produced no statement lines. Check the column mapping and the number of rows skipped.",
      );
    }

    const movementMinor = sum(
      parsed.rows.map((r) => money(r.amountMinor, currency)),
      currency,
    ).minor;

    this.assertTies(openingMinor, movementMinor, closingMinor, currency, parsed.rows.length);

    const warnings = this.collectWarnings(parsed, periodStart, periodEnd, currency);

    const inserted = await this.db.transaction(async (tx) => {
      let statementId: string;
      try {
        const [statement] = await tx
          .insert(bankStatements)
          .values({
            orgId,
            bookId: profile.bookId,
            bankProfileId: profile.id,
            source: "csv",
            periodStart,
            periodEnd,
            openingMinor,
            closingMinor,
            currency,
            fileHash,
            fileName: input.fileName?.trim() || null,
            importedBy: userId,
          })
          .returning({ id: bankStatements.id });
        if (!statement) throw new ConflictException("Could not create the statement");
        statementId = statement.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw this.duplicateFileConflict(input.fileName);
        }
        throw error;
      }

      const rows = await tx
        .insert(bankStatementLines)
        .values(
          parsed.rows.map((row) => ({
            orgId,
            statementId,
            lineNo: row.lineNo,
            valueDate: row.valueDate,
            amountMinor: row.amountMinor,
            description: row.description,
            bankReference: row.bankReference,
            rawRow: row.rawRow,
          })),
        )
        .returning({
          id: bankStatementLines.id,
          lineNo: bankStatementLines.lineNo,
          valueDate: bankStatementLines.valueDate,
          amountMinor: bankStatementLines.amountMinor,
          description: bankStatementLines.description,
          bankReference: bankStatementLines.bankReference,
        });

      return { statementId, rows };
    });

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

  /* ------------------------------------------------------------- internals */

  private async assertNotAlreadyImported(
    orgId: string,
    bankProfileId: string,
    fileHash: string,
  ): Promise<void> {
    const [existing] = await this.db
      .select({ id: bankStatements.id, fileName: bankStatements.fileName, importedAt: bankStatements.importedAt })
      .from(bankStatements)
      .where(
        and(
          eq(bankStatements.orgId, orgId),
          eq(bankStatements.bankProfileId, bankProfileId),
          eq(bankStatements.fileHash, fileHash),
        ),
      )
      .limit(1);

    if (existing) {
      throw new ConflictException(
        `This exact file was already imported on ${existing.importedAt.toISOString().slice(0, 10)} ` +
          `as statement ${existing.id}${existing.fileName ? ` (${existing.fileName})` : ""}. ` +
          "Importing it again would double every line.",
      );
    }
  }

  private duplicateFileConflict(fileName: string | undefined): ConflictException {
    return new ConflictException(
      `This exact file${fileName ? ` (${fileName})` : ""} has already been imported for this bank ` +
        "account. Importing it again would double every line.",
    );
  }

  /**
   * Mapping precedence: what the request says, over the named preset, over what
   * the account has saved. A missing `dateFormat` at the end of that chain is a
   * rejection, not a default.
   */
  private resolveMapping(
    saved: LooseColumnMapping | null,
    presetCode: string | undefined,
    explicit: LooseColumnMapping | undefined,
  ): StatementColumnMapping {
    let base: LooseColumnMapping = saved ?? {};
    if (presetCode) {
      const preset = findMappingPreset(presetCode);
      if (!preset) {
        throw new BadRequestException(
          `Unknown CSV mapping preset ${JSON.stringify(presetCode)}. ` +
            `Known presets: ${STATEMENT_MAPPING_PRESETS.map((p) => p.code).join(", ")}.`,
        );
      }
      base = preset.mapping;
    }

    const merged: LooseColumnMapping = { ...base, ...(explicit ?? {}) };
    if (!presetCode && !explicit && !saved) {
      throw new BadRequestException(
        "This bank account has no saved CSV mapping. Send a mapping, or name a preset, or save one " +
          "against the account first.",
      );
    }

    try {
      return assertMappingIsUsable(merged);
    } catch (error) {
      if (error instanceof StatementCsvError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private requireAmount(raw: string, currency: string, field: string): number {
    let parsed: number | null;
    try {
      parsed = parseAmountToMinor(String(raw ?? ""), currency);
    } catch (error) {
      if (error instanceof StatementCsvError) {
        throw new BadRequestException(`${field}: ${error.message}`);
      }
      throw error;
    }
    if (parsed === null) {
      throw new BadRequestException(
        `${field} is required — a statement without a stated ${field} balance cannot be tied out`,
      );
    }
    return parsed;
  }

  /** `opening + sum(lines) == closing`, loudly. */
  private assertTies(
    openingMinor: number,
    movementMinor: number,
    closingMinor: number,
    currency: string,
    lineCount: number,
  ): void {
    const expected = openingMinor + movementMinor;
    if (expected === closingMinor) return;

    const difference = closingMinor - expected;
    throw new BadRequestException(
      `The statement does not tie: opening ${toDecimalString(money(openingMinor, currency))} ` +
        `+ ${lineCount} lines totalling ${toDecimalString(money(movementMinor, currency))} ` +
        `= ${toDecimalString(money(expected, currency))}, but the closing balance says ` +
        `${toDecimalString(money(closingMinor, currency))} — a difference of ` +
        `${toDecimalString(money(difference, currency))} ${currency}. Nothing was imported.`,
    );
  }

  private collectWarnings(
    parsed: ReturnType<typeof parseStatementCsv>,
    periodStart: string,
    periodEnd: string,
    currency: string,
  ): ImportWarning[] {
    const warnings: ImportWarning[] = [];

    for (const group of findDuplicateLines(parsed.rows)) {
      warnings.push({
        code: "DUPLICATE_LINE",
        message:
          `Lines ${group.lineNos.join(", ")} are identical — ${group.valueDate}, ` +
          `${toDecimalString(money(group.amountMinor, currency))} ${currency}` +
          `${group.bankReference ? `, reference ${group.bankReference}` : ", no reference"}. ` +
          "Both were imported; confirm they are two real movements and not a double export.",
        details: {
          valueDate: group.valueDate,
          amountMinor: group.amountMinor,
          bankReference: group.bankReference,
          lineNos: group.lineNos,
        },
      });
    }

    for (const skipped of parsed.skipped) {
      warnings.push({
        code: "ROW_SKIPPED",
        message: `Row ${skipped.sourceRowNumber} was skipped: ${skipped.reason}`,
        details: { sourceRowNumber: skipped.sourceRowNumber, rawRow: skipped.rawRow },
      });
    }

    const outside = parsed.rows.filter(
      (r) => compareDates(r.valueDate, periodStart) < 0 || compareDates(r.valueDate, periodEnd) > 0,
    );
    for (const row of outside) {
      warnings.push({
        code: "LINE_OUTSIDE_PERIOD",
        message:
          `Line ${row.lineNo} is dated ${row.valueDate}, outside the declared period ` +
          `${periodStart} → ${periodEnd}. Check the declared date format before trusting it.`,
        details: { lineNo: row.lineNo, valueDate: row.valueDate },
      });
    }

    return warnings;
  }

  private isoOrReject(value: string, field: string): string {
    try {
      return assertIsoDate(value);
    } catch {
      throw new BadRequestException(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
    }
  }
}
