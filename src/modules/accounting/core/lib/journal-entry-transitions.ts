/**
 * Posting and reversing an existing journal entry.
 *
 * These two share a failure mode nothing else in the ledger has: each changes
 * the state of an entry that is already balanced and already approved, and each
 * must then invalidate BOTH derived-report caches — `acc:statements:<orgId>` and
 * `fin:reports:<orgId>` — because every statement and every finance report is a
 * reading of posted entries. That invalidation is deferred with
 * `registerAfterCommit` and falls back to running inline when there is no
 * ambient transaction, so a cache is never busted for a write that rolled back
 * and never skipped because there was no hook to hang it on.
 *
 * Reversal is idempotent by construction: it looks for an existing entry with
 * the same (sourceType, sourceId, sourceEvent='reverse') and reports
 * `created: false` rather than refusing, so a retried request does not read as
 * a failure.
 *
 * MONEY: `parseDecimal` swaps each line's debit and credit to build the
 * reversing lines, and returns 0 for a non-finite value rather than NaN. Moved
 * from accounting-ledger.service.ts character for character.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { registerAfterCommit } from "../../../../common/tenant/tenant-context";
import { JournalPostingService, type DraftLine } from "../../posting/journal-posting.service";
import { FinancePostingService } from "../../posting/finance-posting.service";
import { ACCT_STATEMENTS_NS } from "../../settings/accounting-settings.constants";

export interface JournalTransitionDeps {
  readonly db: Db;
  readonly posting: JournalPostingService;
  readonly finPosting: FinancePostingService;
  readonly audit: AuditService;
  readonly cache: CacheService;
}

function todayIsoDate(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDecimal(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function postJournalEntry(
  deps: JournalTransitionDeps,
  orgId: string,
  userId: string,
  entryId: number,
) {
  const rows = await deps.db
    .select({ id: journalEntries.id, status: journalEntries.status, entryDate: journalEntries.entryDate, entryNumber: journalEntries.entryNumber })
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
    .limit(1);

  const entry = rows[0];
  if (!entry) throw new NotFoundException("Journal entry not found");
  if (entry.status === "POSTED") throw new ConflictException("Entry is already posted");
  if (entry.status === "VOID") throw new ConflictException("Cannot post a voided entry");

  await deps.finPosting.assertPeriodOpen(orgId, entry.entryDate);

  if (entry.status === "PENDING_APPROVAL") {
    await deps.finPosting.assertApprovalGranted(orgId, entryId);
  }

  const updated = await deps.db
    .update(journalEntries)
    .set({ status: "POSTED", postedBy: userId, postedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
    .returning({
      id: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      status: journalEntries.status,
    });

  const invalidate = () => Promise.all([
    deps.cache.invalidateNamespace(ACCT_STATEMENTS_NS(orgId)),
    deps.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
  ]);
  if (!registerAfterCommit(invalidate)) await invalidate();

  deps.audit.log({
    action: "accounting.journal.post",
    userId,
    orgId,
    resourceType: "journal_entry",
    resourceId: String(entryId),
    metadata: { entryNumber: entry.entryNumber },
    result: "SUCCESS",
  });

  return updated[0];
}

export async function reverseJournalEntry(
  deps: JournalTransitionDeps,
  orgId: string,
  userId: string,
  entryId: number,
) {
  const today = todayIsoDate();
  await deps.finPosting.assertPeriodOpen(orgId, today);

  const headerRows = await deps.db
    .select({
      id: journalEntries.id,
      orgId: journalEntries.orgId,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      sourceEvent: journalEntries.sourceEvent,
      status: journalEntries.status,
    })
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
    .limit(1);
  const original = headerRows[0];
  if (!original) throw new NotFoundException("Journal entry not found");
  if (original.status !== "POSTED") throw new ConflictException("Only posted entries can be reversed");
  if (original.sourceEvent === "reverse") throw new ConflictException("Cannot reverse a reversing entry");

  const lineRows = await deps.db
    .select({
      debit: journalLines.debit,
      credit: journalLines.credit,
      description: journalLines.description,
      lineOrder: journalLines.lineOrder,
      accountCode: ledgerAccounts.code,
    })
    .from(journalLines)
    .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
    .where(and(eq(journalLines.entryId, original.id), eq(journalLines.orgId, orgId)))
    .orderBy(asc(journalLines.lineOrder));
  if (lineRows.length === 0) throw new ConflictException("Original entry has no lines");

  const reversingLines: DraftLine[] = lineRows.map((line) => ({
    accountCode: line.accountCode,
    debit: parseDecimal(line.credit),
    credit: parseDecimal(line.debit),
    description: `Reverses ${original.entryNumber}: ${line.description ?? ""}`,
  }));

  const sourceIdMatch =
    original.sourceId === null
      ? isNull(journalEntries.sourceId)
      : eq(journalEntries.sourceId, original.sourceId);
  const existing = await deps.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, original.sourceType),
        sourceIdMatch,
        eq(journalEntries.sourceEvent, "reverse"),
      ),
    )
    .limit(1);
  const wasExisting = existing.length > 0;

  const persisted = await deps.db.transaction(async (tx) => {
    const reversed = await deps.posting.persistJournalEntry(
      {
        orgId,
        entryDate: today,
        description: `Reversing entry for ${original.entryNumber}`,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        sourceEvent: "reverse",
        createdBy: userId,
        lines: reversingLines,
      },
      tx,
    );

    await tx
      .update(journalEntries)
      .set({ status: "VOID", reversedEntryId: reversed.id, updatedAt: new Date() })
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)));

    return reversed;
  });

  const invalidateStatements = () => Promise.all([
    deps.cache.invalidateNamespace(ACCT_STATEMENTS_NS(orgId)),
    deps.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
  ]);
  if (!registerAfterCommit(invalidateStatements)) await invalidateStatements();

  deps.audit.log({
    action: "accounting.journal.reverse",
    userId,
    orgId,
    resourceType: "journal_entry",
    resourceId: String(entryId),
    metadata: { reversalEntryId: persisted.id, reversalEntryNumber: persisted.entryNumber },
    result: "SUCCESS",
  });

  return {
    created: !wasExisting,
    result: { id: persisted.id, entryNumber: persisted.entryNumber, created: !wasExisting },
  };
}
