/**
 * What a posting and a reversal announce: the `accounting.journal.posted`
 * outbox event, and the audit-log entries.
 *
 * Split out of `ledger.service.ts`. The event is emitted on the posting
 * transaction, so it commits or rolls back with the journal it describes.
 */
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { DbOrTx } from "../sequence.service";
import type { PostJournalCommand, PostedJournal } from "../ledger.types";

/** A journal the post step has just inserted, as that step knows it. */
export interface InsertedJournal {
  orgId: string;
  userId: string | null;
  command: PostJournalCommand;
  journalId: string;
  journalNumber: string;
  journalDate: string;
}

export async function emitJournalPosted(tx: DbOrTx, journal: InsertedJournal): Promise<void> {
  const { orgId, userId, command, journalId, journalNumber, journalDate } = journal;
  await OutboxWriter.emit(tx, {
    eventId: randomUUID(),
    organizationId: orgId,
    aggregateType: "gl_journal",
    aggregateId: journalId,
    aggregateVersion: Date.now(),
    eventType: "accounting.journal.posted",
    payload: {
      organization_id: orgId,
      book_id: command.bookId,
      journal_id: journalId,
      journal_number: journalNumber,
      journal_date: journalDate,
      source_type: command.sourceType,
      source_id: command.sourceId ?? null,
      actor_user_id: userId,
    },
    occurredAt: new Date(),
  });
}

/**
 * A posting is a privileged act and belongs in the platform audit log
 * (PRD 09 §N). The outbox event beside it is for other systems to consume;
 * this is the record a person can query when asked who booked something.
 */
export function auditJournalPosted(
  audit: AuditService | undefined,
  journal: InsertedJournal,
  posted: PostedJournal,
): void {
  const { orgId, userId, command, journalId, journalNumber, journalDate } = journal;
  audit?.log({
    action: "accounting.journal.posted",
    ...(userId ? { userId } : { systemActor: "accounting.journal.automated-posting" }),
    orgId,
    resourceType: "gl_journals",
    resourceId: journalId,
    after: {
      journalNumber,
      journalDate,
      sourceType: command.sourceType,
      sourceId: command.sourceId ?? null,
      totalDebitMinor: posted.totalDebitMinor,
      currency: posted.functionalCurrency,
    },
  });
}

export function auditJournalReversed(
  audit: AuditService | undefined,
  orgId: string,
  userId: string | null,
  original: PostedJournal,
  reversal: PostedJournal,
): void {
  audit?.log({
    action: "accounting.journal.reversed",
    ...(userId ? { userId } : { systemActor: "accounting.journal.automated-reversal" }),
    orgId,
    resourceType: "gl_journals",
    resourceId: original.id,
    before: { journalNumber: original.journalNumber },
    after: { reversedByJournalNumber: reversal.journalNumber, reversalJournalId: reversal.id },
  });
}
