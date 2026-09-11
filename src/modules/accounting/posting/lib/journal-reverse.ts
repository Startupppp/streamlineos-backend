/**
 * Reversing a posted journal.
 *
 * A reversal is not an edit. `journal_entries` is append-only at the database
 * level (migration 0793 installs an immutability trigger), so undoing a posting
 * means writing a NEW entry whose every line has debit and credit swapped, then
 * marking the original VOID and pointing the two at each other. Both writes are
 * in one transaction, because an original marked VOID with no reversal behind it
 * is a hole in the ledger.
 *
 * The reversal is dated TODAY, not on the original's entry date, and the period
 * check is against today for the same reason: a closed period must not gain a
 * new entry just because the entry it corrects was made while it was open.
 *
 * MONEY: the swap is `debit: formatDecimal(line.credit)`,
 * `credit: formatDecimal(line.debit)` — decimal strings through money.util, the
 * GL kernel's convention. `baseDebit`/`baseCredit` are deliberately null on a
 * reversal line: the original carried the FX conversion and re-deriving it at
 * today's rate would not net to zero against it. Moved from
 * finance-posting.service.ts character for character.
 */
import { BadRequestException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { journalEntries, journalLines } from "../../../../db/schema";
import type { NewJournalLine } from "../../../../db/schema/accounting/accounting";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { registerAfterCommit } from "../../../../common/tenant/tenant-context";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { ACCT_STATEMENTS_NS } from "../../settings/accounting-settings.constants";
import { type DbOrTx } from "../../../../common/rbac/access-invalidate";
import { formatDecimal } from "../../core/money.util";
import type { ReverseJournalResult } from "../../core/finance-posting.types";

export interface JournalReverseDeps {
  readonly db: Db;
  readonly audit: AuditService;
  readonly cache: CacheService;
  /** Bound FinancePostingService.assertPeriodOpen. */
  readonly assertPeriodOpen: (orgId: string, date: string) => Promise<void>;
  /** Bound FinancePostingService.nextSequenceNumber — private, stays private. */
  readonly nextSequenceNumber: (
    orgId: string,
    entryDate: string,
    executor: DbOrTx,
  ) => Promise<string>;
}

function todayIso(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export async function reverseJournal(
  deps: JournalReverseDeps,
  u: CurrentUserContext,
  entryId: number,
  reason?: string,
): Promise<ReverseJournalResult> {
  const { orgId, userId } = u;

  const today = todayIso();
  await deps.assertPeriodOpen(orgId, today);

  const result = await deps.db.transaction(async (tx) => {
    const [original] = await tx
      .select({
        id: journalEntries.id,
        orgId: journalEntries.orgId,
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.entryDate,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
        currency: journalEntries.currency,
        status: journalEntries.status,
        reversedEntryId: journalEntries.reversedEntryId,
      })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, entryId),
          eq(journalEntries.orgId, orgId),
        ),
      )
      .limit(1);

    if (!original) throw new BadRequestException("Journal entry not found");
    if (original.status !== "POSTED") {
      throw new BadRequestException("Only POSTED entries can be reversed");
    }

    const lines = await tx
      .select({
        accountId: journalLines.accountId,
        debit: journalLines.debit,
        credit: journalLines.credit,
        description: journalLines.description,
        lineOrder: journalLines.lineOrder,
        currency: journalLines.currency,
        exchangeRate: journalLines.exchangeRate,
        clientId: journalLines.clientId,
        vendorId: journalLines.vendorId,
        projectId: journalLines.projectId,
        departmentId: journalLines.departmentId,
        employeeId: journalLines.employeeId,
        taxCodeId: journalLines.taxCodeId,
        dimensionValues: journalLines.dimensionValues,
      })
      .from(journalLines)
      .where(and(eq(journalLines.entryId, entryId), eq(journalLines.orgId, orgId)));

    if (lines.length === 0) throw new BadRequestException("Entry has no lines to reverse");

    const reversalEntryNumber = await deps.nextSequenceNumber(orgId, today, tx);
    const reversalDesc = reason
      ? `Reversal of ${original.entryNumber}: ${reason}`
      : `Reversal of ${original.entryNumber}`;

    const [reversal] = await tx
      .insert(journalEntries)
      .values({
        orgId,
        entryNumber: reversalEntryNumber,
        entryDate: today,
        postingDate: today,
        description: reversalDesc,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        sourceEvent: "reverse",
        currency: original.currency,
        status: "POSTED",
        createdBy: userId,
        postedBy: userId,
        postedAt: new Date(),
        reversedEntryId: entryId,
      })
      .returning({ id: journalEntries.id });

    if (!reversal) throw new Error("Reversal entry insert returned no rows");

    const reversalLines: NewJournalLine[] = lines.map((line, idx) => ({
      entryId: reversal.id,
      accountId: line.accountId,
      orgId,
      debit: formatDecimal(line.credit ?? "0"),
      credit: formatDecimal(line.debit ?? "0"),
      description: line.description ? `Reversal: ${line.description}` : null,
      lineOrder: idx,
      currency: line.currency,
      exchangeRate: line.exchangeRate,
      baseDebit: null,
      baseCredit: null,
      clientId: line.clientId,
      vendorId: line.vendorId,
      projectId: line.projectId,
      departmentId: line.departmentId,
      employeeId: line.employeeId,
      taxCodeId: line.taxCodeId,
      dimensionValues: line.dimensionValues,
    }));

    await tx.insert(journalLines).values(reversalLines);

    await tx
      .update(journalEntries)
      .set({ status: "VOID", reversedEntryId: reversal.id, updatedAt: new Date() })
      .where(eq(journalEntries.id, entryId));

    return reversal.id;
  });

  const invalidate = () => Promise.all([
    deps.cache.invalidateNamespace(ACCT_STATEMENTS_NS(orgId)),
    deps.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
  ]);
  if (!registerAfterCommit(invalidate)) await invalidate();

  deps.audit.log({
    action: "accounting.journal.reverse",
    userId,
    orgId,
    resourceType: "journal_entry",
    resourceId: String(entryId),
    metadata: { reversalEntryId: result, reason },
    result: "SUCCESS",
  });

  return { reversalEntryId: result };
}
