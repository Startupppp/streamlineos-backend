import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { glJournalLines, glJournals } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PackRegistry } from "../packs/pack.registry";
import { isUniqueViolation } from "./pg-errors";
import { SequenceService, type DbOrTx } from "./sequence.service";
import {
  LedgerRejection,
  type PostJournalCommand,
  type PostedJournal,
  type ReverseJournalCommand,
} from "./ledger.types";
import { mirrorLines } from "./lib/journal-lines";
import { prepareJournal } from "./lib/posting-preconditions";
import {
  findByIdempotencyKey,
  loadPostedJournal,
  readTrialBalance,
  type TrialBalanceRow,
} from "./lib/journal-reads";
import { auditJournalPosted, auditJournalReversed, emitJournalPosted } from "./lib/journal-events";

/**
 * The ledger kernel.
 *
 * Everything the product knows about money arrives here as a `PostJournal` and
 * leaves as immutable rows. Nothing else in the codebase writes `gl_journals` or
 * `gl_journal_lines` — that is the invariant the rest of accounting rests on.
 *
 * Corrections are reversing journals. There is deliberately no `update` and no
 * `delete` on this class.
 *
 * This file keeps the writes — the journal and line inserts, the idempotency
 * race around them, and the reversal link — and is the one service
 * `ledger-boundary.spec.ts` allows to make them. Validation, balancing, the
 * precondition reads and numbering are in `lib/posting-preconditions.ts` and
 * `lib/journal-lines.ts`; the journal loader and trial balance in
 * `lib/journal-reads.ts`; the outbox event and audit entries in
 * `lib/journal-events.ts`.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sequences: SequenceService,
    private readonly packs: PackRegistry,
    /**
     * `@Optional()` so the kernel stays constructible with `new` in tests that
     * have no request context. Production always gets it — `AuditModule` is
     * global.
     */
    @Optional() private readonly audit?: AuditService,
  ) {}

  /* ------------------------------------------------------------- posting */

  /**
   * Post a balanced journal, or reject and write nothing.
   *
   * Pass `tx` when a document is posting as part of its own transaction — the
   * journal and the document then commit or roll back together.
   */
  async post(
    orgId: string,
    userId: string | null,
    command: PostJournalCommand,
    tx?: DbOrTx,
  ): Promise<PostedJournal> {
    if (tx) return this.postWithin(orgId, userId, command, tx);

    try {
      return await this.db.transaction((t) => this.postWithin(orgId, userId, command, t));
    } catch (error) {
      /**
       * Lost the insert race on `(book_id, idempotency_key)`.
       *
       * The recovery has to happen out here, not inside the transaction that
       * hit the violation: Postgres marks that transaction aborted, so every
       * subsequent statement in it fails with 25P02 and the winner could never
       * be read. On a fresh connection the winner has committed and is
       * readable, which is what makes a double-click idempotent rather than a
       * 500.
       */
      if (isUniqueViolation(error, "uniq_gl_journals_book_idempotency")) {
        const winner = await findByIdempotencyKey(
          orgId,
          command.bookId,
          command.idempotencyKey,
          this.db,
        );
        if (winner) return { ...winner, replayed: true };
      }
      throw error;
    }
  }

  private async postWithin(
    orgId: string,
    userId: string | null,
    command: PostJournalCommand,
    tx: DbOrTx,
  ): Promise<PostedJournal> {
    const prepared = await prepareJournal(this.sequences, this.packs, orgId, command, tx);
    if (prepared.kind === "replay") return { ...prepared.journal, replayed: true };
    const { journalDate, journalNumber, periodId, lines } = prepared;

    let journalId: string;
    try {
      /**
       * The insert runs inside a SAVEPOINT (drizzle renders a nested
       * `transaction()` as one). A unique violation would otherwise abort the
       * whole enclosing transaction, and a document posting through us would
       * lose its own work as well as the ability to read the winner back.
       */
      journalId = await tx.transaction(async (savepoint) => {
        const [inserted] = await savepoint
          .insert(glJournals)
          .values({
            orgId,
            bookId: command.bookId,
            periodId,
            journalNumber,
            journalDate,
            memo: command.memo ?? null,
            sourceType: command.sourceType,
            sourceId: command.sourceId ?? null,
            idempotencyKey: command.idempotencyKey,
            postedByUserId: userId,
          })
          .returning({ id: glJournals.id });
        if (!inserted) throw new Error("Journal insert returned no row");
        return inserted.id;
      });
    } catch (error) {
      // Lost a race against a concurrent post of the same key. The savepoint
      // rolled back, so this transaction is still usable and the winner — if it
      // has committed — is readable. If it has not committed yet, rethrow and
      // let `post` retry the read on a fresh connection.
      if (isUniqueViolation(error, "uniq_gl_journals_book_idempotency")) {
        const winner = await findByIdempotencyKey(
          orgId,
          command.bookId,
          command.idempotencyKey,
          tx,
        );
        if (winner) return { ...winner, replayed: true };
      }
      throw error;
    }

    await tx.insert(glJournalLines).values(
      lines.map((line, index) => ({
        orgId,
        bookId: command.bookId,
        journalId,
        lineNo: index + 1,
        ...line,
      })),
    );

    const insertedJournal = { orgId, userId, command, journalId, journalNumber, journalDate };
    await emitJournalPosted(tx, insertedJournal);

    const posted = await this.loadJournal(orgId, journalId, tx);
    if (!posted) throw new Error(`Journal ${journalId} vanished immediately after insert`);

    // A posting is a privileged act and belongs in the platform audit log (PRD 09 §N).
    auditJournalPosted(this.audit, insertedJournal, posted);

    return posted;
  }

  /* ----------------------------------------------------------- reversing */

  /**
   * Post the mirror of an existing journal and link the two.
   *
   * The original is never rewritten. The only column touched on it is
   * `reversed_by_journal_id`, which is a link rather than a business field, and
   * whose unique index is what makes "reversed at most once" true (invariant 5).
   *
   * A reversal into a locked period is **rejected** rather than silently
   * date-shifted — PRD 01 asks for one behaviour, tested; this is it.
   */
  async reverse(
    orgId: string,
    userId: string | null,
    command: ReverseJournalCommand,
    tx?: DbOrTx,
  ): Promise<PostedJournal> {
    if (tx) return this.reverseWithin(orgId, userId, command, tx);
    return this.db.transaction((t) => this.reverseWithin(orgId, userId, command, t));
  }

  private async reverseWithin(
    orgId: string,
    userId: string | null,
    command: ReverseJournalCommand,
    tx: DbOrTx,
  ): Promise<PostedJournal> {
    const replay = await findByIdempotencyKey(orgId, command.bookId, command.idempotencyKey, tx);
    if (replay) return { ...replay, replayed: true };

    const original = await this.loadJournal(orgId, command.journalId, tx);
    if (!original || original.bookId !== command.bookId) {
      throw new LedgerRejection("JOURNAL_NOT_FOUND", `Journal ${command.journalId} was not found`);
    }
    if (original.reversedByJournalId) {
      throw new LedgerRejection(
        "ALREADY_REVERSED",
        `Journal ${original.journalNumber} was already reversed`,
        undefined,
        { reversedByJournalId: original.reversedByJournalId },
      );
    }

    const reversal = await this.postWithin(
      orgId,
      userId,
      {
        bookId: command.bookId,
        idempotencyKey: command.idempotencyKey,
        journalDate: command.journalDate ?? original.journalDate,
        memo: command.memo ?? `Reversal of ${original.journalNumber}`,
        sourceType: original.sourceType,
        sourceId: original.sourceId ?? undefined,
        // Swap the sides; everything else about the line is carried over.
        lines: mirrorLines(original),
      },
      tx,
    );

    await tx
      .update(glJournals)
      .set({ reversesJournalId: original.id })
      .where(and(eq(glJournals.orgId, orgId), eq(glJournals.id, reversal.id)));

    // Conditional on still being null, so two concurrent reversals cannot both
    // claim the original even if they somehow passed the check above.
    const claimed = await tx
      .update(glJournals)
      .set({ reversedByJournalId: reversal.id })
      .where(
        and(
          eq(glJournals.orgId, orgId),
          eq(glJournals.id, original.id),
          isNull(glJournals.reversedByJournalId),
        ),
      )
      .returning({ id: glJournals.id });

    if (claimed.length === 0) {
      throw new LedgerRejection(
        "ALREADY_REVERSED",
        `Journal ${original.journalNumber} was reversed concurrently`,
      );
    }

    auditJournalReversed(this.audit, orgId, userId, original, reversal);

    return { ...reversal, reversesJournalId: original.id };
  }

  /* -------------------------------------------------------------- reads */

  /** Header plus lines, joined to accounts so a caller never re-queries. */
  async loadJournal(
    orgId: string,
    journalId: string,
    tx: DbOrTx = this.db,
  ): Promise<PostedJournal | null> {
    return loadPostedJournal(orgId, journalId, tx);
  }

  /**
   * Trial balance straight from the lines. There is no balances table to drift
   * out of step with the ledger — PRD 06 forbids one, and this is why it can.
   */
  async trialBalance(
    orgId: string,
    bookId: string,
    asOf: string,
    tx: DbOrTx = this.db,
  ): Promise<TrialBalanceRow[]> {
    return readTrialBalance(orgId, bookId, asOf, tx);
  }
}
