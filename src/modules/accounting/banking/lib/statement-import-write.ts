/**
 * The importer's writes, and the duplicate-file check in front of them.
 *
 * The same file cannot land twice. The SHA-256 of the raw bytes is stored and
 * `uniq_bank_statements_profile_hash` is what actually enforces it; the
 * pre-check here is only there to give a decent message, and an import that
 * races past it still meets the index and gets the same 409.
 */
import { ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { bankStatementLines, bankStatements } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { BankAccountSummary } from "../bank-accounts.service";
import { isUniqueViolation } from "../pg-errors";
import type { ParsedStatementRow } from "../statement-csv";

/** A statement the importer has parsed and tied, ready to write. */
export interface StatementToInsert {
  orgId: string;
  userId: string | null;
  profile: Pick<BankAccountSummary, "id" | "bookId">;
  periodStart: string;
  periodEnd: string;
  openingMinor: number;
  closingMinor: number;
  currency: string;
  fileHash: string;
  fileName: string | undefined;
  lines: readonly ParsedStatementRow[];
}

export async function assertNotAlreadyImported(
  db: Db,
  orgId: string,
  bankProfileId: string,
  fileHash: string,
): Promise<void> {
  const [existing] = await db
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

function duplicateFileConflict(fileName: string | undefined): ConflictException {
  return new ConflictException(
    `This exact file${fileName ? ` (${fileName})` : ""} has already been imported for this bank ` +
      "account. Importing it again would double every line.",
  );
}

/**
 * The statement header and its lines, on the import's own transaction. The
 * header meeting the file-hash index is turned into the duplicate-file 409.
 */
export async function insertStatementWithLines(tx: DbOrTx, input: StatementToInsert) {
  const { orgId, userId, profile, periodStart, periodEnd, openingMinor, closingMinor, currency, fileHash, lines } =
    input;
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
      throw duplicateFileConflict(input.fileName);
    }
    throw error;
  }

  const rows = await tx
    .insert(bankStatementLines)
    .values(
      lines.map((row) => ({
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
}
