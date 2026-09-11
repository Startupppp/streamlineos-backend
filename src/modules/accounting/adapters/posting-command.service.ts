import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { glParties, type GlSystemTag } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { reportError } from "../../../common/observability";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import type { PostJournalLineCommand } from "../kernel/ledger.types";
import type { DbOrTx } from "../kernel/sequence.service";
import {
  AdapterRejection,
  type PayrollRunPosting,
  type PostingCommand,
  type PostingCommandResult,
} from "./posting-command.types";

/**
 * The anti-corruption layer.
 *
 * Every inbound posting from another module funnels through here, is validated
 * exactly like a manual journal, and reaches the ledger only via
 * `LedgerService.post`. There is no faster path and no privileged one — a
 * payroll run gets the same balance check as an accountant's typo.
 */
@Injectable()
export class PostingCommandService {
  private readonly logger = new Logger(PostingCommandService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Translate and post. Idempotent on `{sourceType}:{sourceId}:{purpose}`, so a
   * redelivered event returns the original journal rather than double-posting.
   */
  async submit(
    orgId: string,
    userId: string | null,
    command: PostingCommand,
    tx?: DbOrTx,
  ): Promise<PostingCommandResult> {
    const run = async (executor: DbOrTx): Promise<PostingCommandResult> => {
      const book = await this.books.findDefault(orgId, executor);
      if (!book) {
        // Accounting is opt-in. An org without it enabled is not an error to
        // shout about — the event simply has nowhere to land.
        throw new AdapterRejection(
          "BOOK_NOT_ENABLED",
          `Accounting is not enabled for organization ${orgId}; nothing was posted`,
        );
      }

      const lines = await this.resolveLines(orgId, book.id, book.baseCurrency, command, executor);
      this.assertBalanced(lines, command);

      const posted = await this.ledger.post(
        orgId,
        userId,
        {
          bookId: book.id,
          idempotencyKey: `${command.sourceType}:${command.sourceId}:${command.purpose}`,
          journalDate: command.journalDate,
          memo: command.memo,
          sourceType: command.sourceType,
          sourceId: command.sourceId,
          lines,
        },
        executor,
      );

      return {
        journalId: posted.id,
        journalNumber: posted.journalNumber,
        replayed: posted.replayed,
      };
    };

    try {
      return await (tx ? run(tx) : this.db.transaction(run));
    } catch (error) {
      await this.recordRefusal(orgId, userId, command, error);
      throw error;
    }
  }

  /**
   * Reverse a previously submitted command — a payroll rerun, a voided billing
   * invoice. Never an edit: the original journal stays, a mirror is posted.
   */
  async reverse(
    orgId: string,
    userId: string | null,
    source: { sourceType: PostingCommand["sourceType"]; sourceId: string; purpose: string },
    journalDate: string,
    tx?: DbOrTx,
  ): Promise<PostingCommandResult | null> {
    const run = async (executor: DbOrTx): Promise<PostingCommandResult | null> => {
      const book = await this.books.findDefault(orgId, executor);
      if (!book) return null;

      const original = await this.findBySource(
        orgId,
        book.id,
        `${source.sourceType}:${source.sourceId}:${source.purpose}`,
        executor,
      );
      if (!original) return null;

      const reversal = await this.ledger.reverse(
        orgId,
        userId,
        {
          bookId: book.id,
          journalId: original.id,
          journalDate,
          idempotencyKey: `${source.sourceType}:${source.sourceId}:reverse`,
        },
        executor,
      );
      return {
        journalId: reversal.id,
        journalNumber: reversal.journalNumber,
        replayed: reversal.replayed,
      };
    };

    return tx ? run(tx) : this.db.transaction(run);
  }

  /**
   * A payroll run becomes one summary journal.
   *
   * Positive amounts debit, negative credit — payroll thinks in "salary expense
   * 500,000, PF payable 60,000, net pay 440,000" and should not have to think in
   * debits and credits to hand that over.
   */
  async submitPayrollRun(
    orgId: string,
    userId: string | null,
    run: PayrollRunPosting,
    tx?: DbOrTx,
  ): Promise<PostingCommandResult> {
    return this.submit(
      orgId,
      userId,
      {
        sourceType: "payroll_run",
        sourceId: run.runId,
        purpose: "post",
        journalDate: run.postingDate,
        memo: run.periodLabel ? `Payroll ${run.periodLabel}` : `Payroll run ${run.runId}`,
        lines: run.lines.map((line) => ({
          accountTag: line.tag,
          debitMinor: line.amountMinor > 0 ? line.amountMinor : undefined,
          creditMinor: line.amountMinor < 0 ? -line.amountMinor : undefined,
          currency: run.currency,
          description: line.description,
          dimensionBranchId: line.dimensionBranchId,
        })),
      },
      tx,
    );
  }

  /* ------------------------------------------------------------ internals */

  /**
   * Leave a durable trace of a refusal, so a caller that swallows one cannot
   * make it invisible.
   *
   * The ACL cannot force a caller to rethrow, and one already does not:
   * `payroll-posting.service.ts` wraps its paid-disbursement posting in
   * `catch (err) { this.logger.error(...) }`, so a locked period or a missing
   * `net_pay_clearing` account leaves the payroll run looking posted with no
   * journal behind it. That code is payroll's business logic and not this
   * pack's to change — but making the refusal survive independently of what
   * the caller does with it *is* the adapter contract, which is what ACC-15
   * asks for.
   *
   * Outside the transaction, deliberately. A refusal is delivered by throwing,
   * the throw unwinds through `TenantContextInterceptor`, `withTenant` rolls
   * the request transaction back, and an audit row written inside it would be
   * rolled back too — the one entry nobody can reconstruct from the data would
   * be the only one that never survives.
   *
   * `BOOK_NOT_ENABLED` is excluded. It is the honest opt-out and is raised on
   * every posting attempt by every organisation that never enabled accounting;
   * auditing it would bury the real refusals under enormous volume.
   */
  private async recordRefusal(
    orgId: string,
    userId: string | null,
    command: PostingCommand,
    error: unknown,
  ): Promise<void> {
    if (error instanceof AdapterRejection && error.code === "BOOK_NOT_ENABLED") return;

    const code = error instanceof AdapterRejection ? error.code : "UNEXPECTED";
    try {
      await this.audit.logCriticalOutsideTransaction({
        action: "accounting.posting.refused",
        orgId,
        /*
          A posting can arrive unattended — a payroll lock from a sweep, an
          outbox redelivery — and the audit table's actor is a union rather
          than a nullable id precisely so "nobody acted" cannot be confused
          with "an actor was lost".
        */
        ...(userId === null
          ? { systemActor: `accounting-adapter:${command.sourceType}` as const }
          : { userId }),
        resourceType: "gl_journals",
        resourceId: `${command.sourceType}:${command.sourceId}:${command.purpose}`,
        result: "FAILURE",
        metadata: {
          code,
          message: error instanceof Error ? error.message : String(error),
          sourceType: command.sourceType,
          sourceId: command.sourceId,
          purpose: command.purpose,
          journalDate: command.journalDate,
        },
      });
    } catch (auditError) {
      /*
        The rejection is the signal the caller needs; an audit-infrastructure
        failure must not replace it. Swapping "this book has no account tagged
        cogs" for "audit write failed" would turn an actionable message into an
        unactionable one, so this is logged and the original rethrown.
      */
      this.logger.error(
        `Could not record a refused posting for ${command.sourceType} ${command.sourceId}: ` +
          `${auditError instanceof Error ? auditError.message : String(auditError)}`,
      );
    }
  }

  private async resolveLines(
    orgId: string,
    bookId: string,
    baseCurrency: string,
    command: PostingCommand,
    tx: DbOrTx,
  ): Promise<PostJournalLineCommand[]> {
    const tags = [
      ...new Set(command.lines.map((l) => l.accountTag).filter((t): t is GlSystemTag => Boolean(t))),
    ];

    let byTag = new Map<GlSystemTag, string>();
    if (tags.length > 0) {
      try {
        byTag = await this.books.resolveAccountsByTag(bookId, tags, tx);
      } catch (error) {
        throw new AdapterRejection(
          "UNKNOWN_ACCOUNT_TAG",
          error instanceof Error ? error.message : "Could not resolve an account role",
          { tags },
        );
      }
    }

    const resolved: PostJournalLineCommand[] = [];
    for (const [index, line] of command.lines.entries()) {
      const accountId = line.accountId ?? (line.accountTag ? byTag.get(line.accountTag) : undefined);
      if (!accountId) {
        throw new AdapterRejection(
          "UNKNOWN_ACCOUNT_TAG",
          `Line ${index + 1} names neither a known account role nor an account id`,
          { line },
        );
      }

      const partyId = line.partyExternalRef
        ? await this.resolvePartyByExternalRef(orgId, bookId, line.partyExternalRef, tx)
        : undefined;

      resolved.push({
        accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        txnCurrency: line.currency ?? baseCurrency,
        txnAmountMinor: line.txnAmountMinor,
        fxRate: line.fxRate,
        partyId: partyId ?? undefined,
        description: line.description,
        dimensionBranchId: line.dimensionBranchId,
        dimensionProjectId: line.dimensionProjectId,
        dimensionCostCenterId: line.dimensionCostCenterId,
      });
    }
    return resolved;
  }

  /**
   * Fail the balance check *here* with the caller's own vocabulary, before the
   * kernel sees it. "Payroll sent lines that differ by 1200" is a far more
   * actionable message than a generic unbalanced-journal rejection.
   */
  private assertBalanced(lines: PostJournalLineCommand[], command: PostingCommand): void {
    const debit = lines.reduce((a, l) => a + (l.debitMinor ?? 0), 0);
    const credit = lines.reduce((a, l) => a + (l.creditMinor ?? 0), 0);
    if (debit !== credit) {
      /*
        Reported, not merely thrown. This is a defect in the sending module —
        payroll or billing computed totals that do not add up — and it answers
        500 for exactly that reason, so it must reach the error tracker rather
        than sitting in a 409 that looks like somebody's configuration.
      */
      reportError(new Error(`Unbalanced posting command from ${command.sourceType}`), {
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        debit,
        credit,
      });
      throw new AdapterRejection(
        "UNBALANCED_COMMAND",
        `${command.sourceType} ${command.sourceId} does not balance: debits ${debit}, credits ${credit}, ` +
          `difference ${debit - credit}. The sending module's totals are wrong; accounting will not adjust them.`,
        { sourceType: command.sourceType, sourceId: command.sourceId, debit, credit },
      );
    }
  }

  /** One accounting party per external record — never a duplicate customer. */
  private async resolvePartyByExternalRef(
    orgId: string,
    bookId: string,
    ref: { system: string; id: string },
    tx: DbOrTx,
  ): Promise<string | null> {
    const [row] = await tx
      .select({ id: glParties.id })
      .from(glParties)
      .where(
        and(
          eq(glParties.orgId, orgId),
          eq(glParties.bookId, bookId),
          isNull(glParties.deletedAt),
          sql`${glParties.externalRefs} @> ${JSON.stringify([{ system: ref.system, id: ref.id }])}::jsonb`,
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  private async findBySource(orgId: string, bookId: string, idempotencyKey: string, tx: DbOrTx) {
    const rows = await tx.execute(
      sql`SELECT id FROM gl_journals
          WHERE org_id = ${orgId} AND book_id = ${bookId} AND idempotency_key = ${idempotencyKey}
          LIMIT 1`,
    );
    const row = (rows as unknown as Array<{ id: string }>)[0];
    return row ? { id: row.id } : null;
  }
}
