/**
 * The two writes on `bank_matches`: recording a match and removing one.
 *
 * Four partial unique indexes make a match 1:1 — one per statement line,
 * receipt, payment and journal. The insert is the enforcement; this file only
 * turns the `23505` into a 409 that names which side was already spoken for.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { bankMatches } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { money, toDecimalString } from "../../kernel/money";
import type { MatchCounterpart, RecordedMatch, StatementLineContext } from "../matching.types";
import { isUniqueViolation, violatedConstraint } from "../pg-errors";
import { counterpartPeriod } from "./match-counterparts";

/**
 * Insert the link for `MatchingService.match`, which has already resolved the
 * counterpart and checked that the amounts agree.
 */
export async function recordMatch(
  db: Db,
  orgId: string,
  userId: string | null,
  line: StatementLineContext,
  counterpart: MatchCounterpart,
): Promise<RecordedMatch> {
  try {
    const [row] = await db
      .insert(bankMatches)
      .values({
        orgId,
        bookId: line.profile.bookId,
        statementLineId: line.id,
        kind: counterpart.kind,
        receiptId: counterpart.kind === "receipt" ? counterpart.id : null,
        paymentId: counterpart.kind === "payment" ? counterpart.id : null,
        journalId: counterpart.kind === "journal" ? counterpart.id : null,
        matchedBy: userId,
      })
      .returning();
    if (!row) throw new ConflictException("Could not record the match");

    return {
      id: row.id,
      statementLineId: row.statementLineId,
      kind: row.kind,
      counterpartId: counterpart.id,
      amountMinor: line.amountMinor,
      currency: line.profile.currency,
      matchedAt: row.matchedAt,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictException(conflictMessage(error, line, counterpart));
    }
    throw error;
  }
}

/** A 409 that says which side was already spoken for. */
function conflictMessage(
  error: unknown,
  line: StatementLineContext,
  counterpart: MatchCounterpart,
): string {
  const detail = violatedConstraint(error);

  if (detail.includes("statement_line")) {
    return (
      `Bank line ${line.lineNo} (${line.valueDate}, ` +
      `${toDecimalString(money(line.amountMinor, line.profile.currency))} ${line.profile.currency}) ` +
      "is already matched. Unmatch it first — a bank line explains exactly one thing."
    );
  }
  const noun =
    counterpart.kind === "receipt" ? "receipt" : counterpart.kind === "payment" ? "payment" : "journal";
  return (
    `That ${noun} is already matched to a different bank line. One ${noun} cannot explain two ` +
    "bank movements; unmatch the other line first."
  );
}

/**
 * The body of `MatchingService.unmatch`: refuse while the counterpart's period
 * is LOCKED, otherwise delete the link.
 */
export async function removeMatch(
  db: Db,
  orgId: string,
  statementLineId: string,
): Promise<{ statementLineId: string; removed: true }> {
  const [existing] = await db
    .select({
      id: bankMatches.id,
      bookId: bankMatches.bookId,
      kind: bankMatches.kind,
      receiptId: bankMatches.receiptId,
      paymentId: bankMatches.paymentId,
      journalId: bankMatches.journalId,
    })
    .from(bankMatches)
    .where(and(eq(bankMatches.orgId, orgId), eq(bankMatches.statementLineId, statementLineId)))
    .limit(1);

  if (!existing) throw new NotFoundException("That bank line is not matched");

  const period = await counterpartPeriod(db, orgId, existing);
  if (period && period.status === "LOCKED") {
    throw new ConflictException(
      `${period.name} is locked, so this match cannot be undone. Reopen the period, or correct the ` +
        "books with a reversing journal instead.",
    );
  }

  await db.delete(bankMatches).where(and(eq(bankMatches.orgId, orgId), eq(bankMatches.id, existing.id)));
  return { statementLineId, removed: true };
}
