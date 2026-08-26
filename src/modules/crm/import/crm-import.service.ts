import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import {
  businessParties,
  crmImportRows,
  crmImports,
  dataQualityFindings,
  workflowRuns,
} from "../../../db/schema";
import type { ImportStatus, StoredColumnMapping } from "../../../db/schema/crm/imports";
import { WorkflowRunnerService } from "../../../common/workflow";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { PartyFingerprint } from "../../party/party-duplicates";
import {
  duplicateFieldAssignments,
  isImportField,
  mapColumns,
  needsConfirmation,
  type MappedColumn,
} from "./column-mapping";
import { blockingKeysFor, isPartyType, planImport, type BlockingKeys, type RowMatch } from "./import-plan";
import { softDeletePartyWithMirror, updatePartyWithMirror } from "../../party/party-legacy-writer";
import { claimIdentifiers, identifierClaimsOfColumns } from "../../party/party-identifiers";
import { uncertaintyFinding } from "./import-uncertainty";
import { COMMIT_WORKFLOW, REVERT_WORKFLOW } from "./import-workflow-names";

/**
 * How many rows one preview accepts.
 *
 * Not the commit's ceiling any more — that is durable, chunked and bounded only
 * by how long the tenant is willing to wait. This is the *preview's* ceiling,
 * and it is a property of the transport: the whole file arrives as one JSON body
 * and `main.ts` caps a JSON body at 3mb. Raising this number without a streamed
 * or multipart upload behind it would move the failure from a clear refusal to a
 * 413 nobody can act on.
 */
export const MAX_ROWS = 5_000;

/**
 * How many existing parties one preview will weigh a file against.
 *
 * A ceiling rather than a sample: candidates are fetched by identifier now, so
 * a tenant reaches this only by having thousands of parties that genuinely
 * share a tax number, an address or a phone line with the file. That is worth
 * saying out loud, which is what `warnings` is for.
 */
const MAX_CANDIDATES = 10_000;

/** Identifiers per statement, so a five-thousand-row file is a few queries. */
const KEYS_PER_QUERY = 500;

/** Rows per INSERT, so a five-thousand-row plan is ten statements, not one. */
const PLAN_INSERT_CHUNK = 500;

/**
 * How long an import stays reversible.
 *
 * A window rather than forever, and stamped rather than derived: see
 * `crm_imports.revert_deadline_at`. Thirty days is the same order as the notice
 * a tenant gets for anything else destructive here, and it is long enough that
 * "we imported the wrong file last month" is still recoverable while short
 * enough that the before-images are not an indefinite second copy of the CRM.
 */
export const REVERT_WINDOW_DAYS = 30;

/**
 * The normalisations `party-duplicates` compares with, written in SQL.
 *
 * These may be WIDER than their TypeScript counterparts — an extra candidate
 * costs one comparison — but never narrower: a candidate this fails to fetch is
 * a duplicate party created in silence.
 */
const NORMALISED: Readonly<Record<"taxNumber" | "email" | "phone" | "host", SQL>> = {
  taxNumber: sql`upper(regexp_replace(coalesce(${businessParties.taxNumber}, ''), '[^A-Za-z0-9]', '', 'g'))`,
  email: sql`lower(trim(coalesce(${businessParties.email}, '')))`,
  phone: sql`right(regexp_replace(coalesce(${businessParties.phone}, ''), '[^0-9]', '', 'g'), 10)`,
  host: sql`regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(${businessParties.website}, ''))), '^[a-z]+://', ''), '/.*$', ''), '^www\\.', '')`,
};

/**
 * The values these columns hold when nobody has chosen one.
 *
 * Read off the schema rather than repeated here, so a changed default cannot
 * quietly re-break the fields it governs.
 */
const COLUMN_DEFAULTS: Readonly<Record<string, unknown>> = {
  partyType: businessParties.partyType.default,
  status: businessParties.status.default,
};

/** Statuses a run is still going to do something about. */
const LIVE_RUN_STATUSES = ["PENDING", "RUNNING", "SLEEPING"];

/**
 * What `beginCommit` and `beginRevert` freeze for the life of a run.
 *
 * A type alias rather than an interface, and that is load-bearing: a step's
 * return value has to satisfy `JsonValue`, and TypeScript gives an object type
 * alias an implicit index signature while an interface gets none.
 */
export type PhaseExtent = {
  /** `true` when there is nothing left for this run to do. */
  readonly settled: boolean;
  readonly total: number;
  /**
   * The last line number in the file, which is what the windows are cut from.
   *
   * The *count* would be wrong: a plan whose rows were partly removed still has
   * to be walked to its end, and counting would stop short and leave the tail of
   * the file unimported with the run reporting success.
   */
  readonly maxRowNumber: number;
};

/** What one batch step did, and what the run adds up. Mutable: it is a tally. */
export type BatchOutcome = {
  created: number;
  updated: number;
  merged: number;
  review: number;
  skipped: number;
  failed: number;
};

const NO_OUTCOME: BatchOutcome = {
  created: 0,
  updated: 0,
  merged: 0,
  review: 0,
  skipped: 0,
  failed: 0,
};

export type ImportProgress = {
  readonly crmImportId: string;
  readonly status: ImportStatus;
  /** The run doing the work, and what the runtime currently thinks of it. */
  readonly workflowRunId: string | null;
  readonly runStatus: string | null;
  /** Nothing further will happen without another request. */
  readonly complete: boolean;
  readonly total: number;
  /** Rows this phase has still to reach. */
  readonly remaining: number;
  readonly created: number;
  readonly updated: number;
  readonly merged: number;
  readonly review: number;
  readonly skipped: number;
  readonly failed: number;
  readonly reverted: number;
  readonly revertDeadlineAt: Date | null;
};

@Injectable()
export class CrmImportService {
  private readonly logger = new Logger("CrmImport");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflows: WorkflowRunnerService,
  ) {}

  /**
   * Work out what this file would do, and store the answer.
   *
   * Nothing is written to the CRM here. The plan is persisted because the
   * commit executes *these rows* rather than re-deriving them — re-deriving
   * would let the answer change between the preview and the commit, which is
   * precisely what the criterion forbids.
   */
  async preview(input: {
    organizationId: string;
    userId: string;
    filename?: string;
    headers: readonly string[];
    rows: readonly (readonly string[])[];
    /** A person's answers to ambiguous columns, from a previous preview. */
    overrides?: Readonly<Record<string, string>>;
  }) {
    if (input.rows.length > MAX_ROWS)
      throw new ConflictException(
        `That file has ${input.rows.length} rows; ${MAX_ROWS} is the most this import handles.`,
      );

    const columns = applyOverrides(mapColumns(input.headers), input.overrides);
    const unanswered = needsConfirmation(columns);
    const candidates = await this.existingFingerprints(
      input.organizationId,
      blockingKeysFor(columns, input.rows),
    );
    const plan = planImport({ columns, rows: input.rows, existing: candidates.fingerprints });

    const warnings = candidates.truncated
      ? [
          `This file matches more than ${MAX_CANDIDATES} existing records on an identifier, so only the first ${MAX_CANDIDATES} were compared. Some rows shown as new may already exist.`,
        ]
      : [];

    const [imported] = await this.db
      .insert(crmImports)
      .values({
        organizationId: input.organizationId,
        status: "previewing",
        sourceFilename: input.filename ?? null,
        columns: columns as unknown as StoredColumnMapping[],
        summary: plan.summary,
        createdByUserId: input.userId,
      })
      .returning({ id: crmImports.crmImportId });

    if (!imported) throw new ConflictException("Could not start the import.");

    const values = plan.rows.map((row) => ({
      organizationId: input.organizationId,
      crmImportId: imported.id,
      rowNumber: row.rowNumber,
      action: row.action,
      reason: row.reason,
      values: row.values as Record<string, string>,
      customFields: row.customFields as Record<string, string>,
      matchedPartyId: row.matchedPartyId ?? null,
      duplicateOfRow: row.duplicateOfRow ?? null,
      match: row.match ? { ...row.match, signals: [...row.match.signals] } : null,
    }));

    // Chunked, because five thousand rows of a dozen columns each is well past
    // the parameter limit one statement can carry.
    for (let index = 0; index < values.length; index += PLAN_INSERT_CHUNK)
      await this.db.insert(crmImportRows).values(values.slice(index, index + PLAN_INSERT_CHUNK));

    return {
      crmImportId: imported.id,
      columns,
      needsConfirmation: unanswered,
      summary: plan.summary,
      warnings,
      // A sample, not the file. A preview that ships ten thousand rows to a
      // browser is a preview nobody waits for.
      rows: plan.rows.slice(0, 50),
    };
  }

  /** The stored plan, for the preview screen and for the commit. */
  async getImport(organizationId: string, crmImportId: string) {
    const [imported] = await this.db
      .select()
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");

    const rows = await this.db
      .select()
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
        ),
      )
      .orderBy(asc(crmImportRows.rowNumber))
      .limit(200);

    return { ...imported, rows };
  }

  // ── Starting the durable runs ─────────────────────────────────────────────

  /**
   * Hands the file to the workflow runtime, once.
   *
   * Re-uses the live run rather than starting a second, because a caller polling
   * by re-POSTing must not spawn a run per poll. A run that dead-lettered or was
   * cancelled is *not* live, and asking again starts a fresh one — which is the
   * recovery path for an import that hit three infrastructure failures, and is
   * safe because every step and every row claim is idempotent.
   */
  async startCommit(organizationId: string, crmImportId: string): Promise<string> {
    return this.inOwnTransaction(organizationId, () =>
      this.claimForCommit(organizationId, crmImportId),
    );
  }

  private async claimForCommit(organizationId: string, crmImportId: string): Promise<string> {
    const [imported] = await this.db
      .select({ status: crmImports.status, workflowRunId: crmImports.workflowRunId })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");
    if (imported.status !== "previewing" && imported.status !== "committing")
      throw new ConflictException(`That import is already ${imported.status}.`);

    return this.startPhase(organizationId, crmImportId, {
      workflowName: COMMIT_WORKFLOW,
      existingRunId: imported.workflowRunId,
      input: { crmImportId },
      column: "workflowRunId",
    });
  }

  /**
   * Take the whole thing back — durably, and only inside the window.
   *
   * The window is checked here rather than in the workflow so the refusal
   * reaches the person who asked, as a refusal. A run that started and then
   * discovered it was too late would report a dead-lettered workflow for what is
   * an ordinary answer.
   */
  async startRevert(
    organizationId: string,
    userId: string,
    crmImportId: string,
  ): Promise<string> {
    return this.inOwnTransaction(organizationId, () =>
      this.claimForRevert(organizationId, userId, crmImportId),
    );
  }

  private async claimForRevert(
    organizationId: string,
    userId: string,
    crmImportId: string,
  ): Promise<string> {
    const [imported] = await this.db
      .select({
        status: crmImports.status,
        revertDeadlineAt: crmImports.revertDeadlineAt,
        revertWorkflowRunId: crmImports.revertWorkflowRunId,
      })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");
    if (imported.status !== "committed" && imported.status !== "reverting")
      throw new ConflictException("Only a committed import can be taken back.");

    if (imported.revertDeadlineAt && imported.revertDeadlineAt.getTime() < Date.now())
      throw new ConflictException(
        `This import stopped being reversible on ${imported.revertDeadlineAt.toISOString().slice(0, 10)}. ` +
          "The records it wrote are ordinary records now and can be edited or deleted individually.",
      );

    return this.startPhase(organizationId, crmImportId, {
      workflowName: REVERT_WORKFLOW,
      existingRunId: imported.revertWorkflowRunId,
      input: { crmImportId, userId },
      column: "revertWorkflowRunId",
    });
  }

  /**
   * Runs `fn` in a transaction of its own, committed before this returns.
   *
   * The run row has to be VISIBLE to something else the moment this call ends,
   * and that is not true of a write made in the request's own transaction. The
   * pump claims the run on a second connection, and a row that has not committed
   * is a row it cannot see — so the import would be handed to a runtime and then
   * never advance until a cron tick that may not exist. `runInNewTenantTransaction`
   * exits the ambient context, so `this.db` inside resolves to the new
   * transaction rather than the request's.
   */
  private inOwnTransaction<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return runInNewTenantTransaction(this.db, organizationId, () => fn());
  }

  private async startPhase(
    organizationId: string,
    crmImportId: string,
    phase: {
      workflowName: string;
      existingRunId: string | null;
      input: Record<string, unknown>;
      column: "workflowRunId" | "revertWorkflowRunId";
    },
  ): Promise<string> {
    if (phase.existingRunId) {
      const [run] = await this.db
        .select({ status: workflowRuns.status })
        .from(workflowRuns)
        .where(
          and(
            // `workflow_runs` is deliberately outside row-level security, so the
            // organisation is a predicate here rather than something the
            // database is asserting for us.
            eq(workflowRuns.organizationId, organizationId),
            eq(workflowRuns.workflowRunId, phase.existingRunId),
          ),
        )
        .limit(1);

      if (run && LIVE_RUN_STATUSES.includes(run.status)) return phase.existingRunId;
    }

    const runId = await this.workflows.start({
      organizationId,
      workflowName: phase.workflowName,
      input: phase.input,
      /**
       * Five, matching the runtime's own default. A suspension does not spend an
       * attempt, so these are five genuine failures — and a file that is minutes
       * of writes deserves more than the three a short workflow needs.
       */
      maxAttempts: 5,
    });

    if (!runId) throw new ConflictException("Could not start the import run.");

    await this.db
      .update(crmImports)
      .set({ [phase.column]: runId })
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      );

    return runId;
  }

  // ── The commit, one memoised batch at a time ──────────────────────────────

  /**
   * Claims the import for this run and freezes what the run will walk.
   *
   * Memoised as a step, which is the point: the batch windows are cut from
   * `maxRowNumber`, so if that were re-read on every attempt a plan edited
   * mid-import would move the boundaries and a memo would stop meaning the rows
   * it was recorded for. Reading it once and keeping the answer with the run is
   * what makes `commit-batch-7` the same seven hundred rows forever.
   *
   * Claimed by locking the import row rather than by a conditional update, so a
   * second run waits for the first and then sees what it left, instead of both
   * reading the same outstanding rows.
   */
  async beginCommit(organizationId: string, crmImportId: string): Promise<PhaseExtent> {
    const [imported] = await this.db
      .select({ status: crmImports.status })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1)
      .for("update");

    if (!imported) throw new NotFoundException("Import not found");

    /**
     * Settled rather than thrown.
     *
     * A run that arrives after the import is already committed has nothing to
     * do, and that is not a failure: throwing would burn five attempts and
     * dead-letter a run whose work somebody else finished.
     */
    if (imported.status !== "previewing" && imported.status !== "committing")
      return { settled: true, total: 0, maxRowNumber: 0 };

    if (imported.status === "previewing")
      await this.db
        .update(crmImports)
        .set({ status: "committing" })
        .where(
          and(
            eq(crmImports.organizationId, organizationId),
            eq(crmImports.crmImportId, crmImportId),
          ),
        );

    return this.extentOf(organizationId, crmImportId);
  }

  /**
   * One window of the file, in one transaction, with one savepoint per row.
   *
   * Every write in here is idempotent, and it has to be for two independent
   * reasons the runtime imposes. `step.run` re-runs a step whose previous
   * attempt FAILED — only a COMPLETED step is memoised — and two runs can
   * legitimately overlap after a dead-letter and a fresh commit. So a row is
   * *claimed* before it is written: `committed_at IS NULL` in the UPDATE, and no
   * row back means somebody already did this one.
   *
   * The claim shares the row's savepoint with the write, so a row that fails
   * rolls back its own claim and is genuinely outstanding again — rather than
   * being marked done by a claim that outlived the work it was standing for.
   */
  async commitBatch(
    organizationId: string,
    crmImportId: string,
    window: { fromRow: number; toRow: number },
  ): Promise<BatchOutcome> {
    const rows = await this.db
      .select({ crmImportRowId: crmImportRows.crmImportRowId, rowNumber: crmImportRows.rowNumber })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
          isNull(crmImportRows.committedAt),
          gte(crmImportRows.rowNumber, window.fromRow),
          lte(crmImportRows.rowNumber, window.toRow),
        ),
      )
      .orderBy(asc(crmImportRows.rowNumber));

    if (rows.length === 0) return NO_OUTCOME;

    const filename = await this.filenameOf(organizationId, crmImportId);
    const tally = { ...NO_OUTCOME };

    for (const row of rows) {
      try {
        /**
         * One savepoint per row, and this is the whole reason the loop has a
         * shape at all.
         *
         * `this.db` resolves to the step's ambient transaction, so this opens a
         * SAVEPOINT rather than a second transaction. Postgres aborts the entire
         * transaction on a statement error and Drizzle takes no per-statement
         * savepoint, so without one a single bad cell — a NUL byte in a custom
         * field is enough — poisons everything after it: the `catch` below would
         * throw `25P02` recording the error, that throw would escape the step,
         * and the step's rollback would take the whole batch with it.
         *
         * It also makes each row atomic: a party is never created without the
         * row that records how to undo it.
         */
        const outcome = await this.db.transaction((tx) =>
          this.commitRow(tx, organizationId, crmImportId, row.crmImportRowId, filename),
        );

        if (outcome) tally[outcome] += 1;
      } catch (error) {
        tally.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`import ${crmImportId} row ${String(row.rowNumber)}: ${message}`);
        /**
         * Runs in the step's transaction, which the savepoint's rollback left
         * usable. `committed_at` goes down with the error deliberately: a cell
         * Postgres refuses will be refused again, and a row that stays
         * outstanding would be retried by every later attempt and hold the
         * import open forever. The error is the record of what happened to it.
         */
        await this.db
          .update(crmImportRows)
          .set({ error: message, committedAt: new Date() })
          .where(
            and(
              eq(crmImportRows.organizationId, organizationId),
              eq(crmImportRows.crmImportRowId, row.crmImportRowId),
            ),
          );
      }
    }

    return tally;
  }

  /**
   * Closes the import, once every window has been walked.
   *
   * Guarded on `committing`, so a second run's finish is a no-op rather than a
   * second `committed_at` and a second reversal window.
   */
  async finishCommit(organizationId: string, crmImportId: string): Promise<void> {
    const now = new Date();
    const deadline = new Date(now.getTime() + REVERT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    await this.db
      .update(crmImports)
      .set({ status: "committed", committedAt: now, revertDeadlineAt: deadline })
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
          eq(crmImports.status, "committing"),
        ),
      );
  }

  // ── The undo, the same way ────────────────────────────────────────────────

  async beginRevert(organizationId: string, crmImportId: string): Promise<PhaseExtent> {
    const [imported] = await this.db
      .select({ status: crmImports.status, revertDeadlineAt: crmImports.revertDeadlineAt })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1)
      .for("update");

    if (!imported) throw new NotFoundException("Import not found");
    if (imported.status !== "committed" && imported.status !== "reverting")
      return { settled: true, total: 0, maxRowNumber: 0 };

    if (imported.status === "committed")
      await this.db
        .update(crmImports)
        .set({ status: "reverting" })
        .where(
          and(
            eq(crmImports.organizationId, organizationId),
            eq(crmImports.crmImportId, crmImportId),
          ),
        );

    return this.extentOf(organizationId, crmImportId);
  }

  /**
   * One window of the file, put back.
   *
   * Rows descend inside the window and the workflow walks the windows in reverse
   * too, so a later row that updated a party an earlier row created is undone
   * before the party it points at disappears. The claim is `reverted_at IS NULL`
   * against a row that was committed, which is the same idempotence the commit
   * has and for the same reasons.
   */
  async revertBatch(
    organizationId: string,
    crmImportId: string,
    window: { fromRow: number; toRow: number },
  ): Promise<{ deleted: number; restored: number; dismissed: number; failed: number }> {
    const rows = await this.db
      .select({ crmImportRowId: crmImportRows.crmImportRowId, rowNumber: crmImportRows.rowNumber })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
          isNotNull(crmImportRows.committedAt),
          isNull(crmImportRows.revertedAt),
          gte(crmImportRows.rowNumber, window.fromRow),
          lte(crmImportRows.rowNumber, window.toRow),
        ),
      )
      .orderBy(desc(crmImportRows.rowNumber));

    const tally = { deleted: 0, restored: 0, dismissed: 0, failed: 0 };

    for (const row of rows) {
      try {
        const outcome = await this.db.transaction((tx) =>
          this.revertRow(tx, organizationId, row.crmImportRowId),
        );
        if (outcome) tally[outcome] += 1;
      } catch (error) {
        tally.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`revert ${crmImportId} row ${String(row.rowNumber)}: ${message}`);
        await this.db
          .update(crmImportRows)
          .set({ error: message, revertedAt: new Date() })
          .where(
            and(
              eq(crmImportRows.organizationId, organizationId),
              eq(crmImportRows.crmImportRowId, row.crmImportRowId),
            ),
          );
      }
    }

    return tally;
  }

  async finishRevert(
    organizationId: string,
    crmImportId: string,
    userId: string,
  ): Promise<void> {
    await this.db
      .update(crmImports)
      .set({ status: "reverted", revertedAt: new Date(), revertedByUserId: userId })
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
          eq(crmImports.status, "reverting"),
        ),
      );
  }

  // ── What the caller polls ─────────────────────────────────────────────────

  /**
   * Where this import has got to, counted from the rows themselves.
   *
   * Counted rather than accumulated, because the run's own tallies are memoised
   * per step and a caller arriving mid-run has no way to add them up. The rows
   * are the ledger; everything here is a `FILTER` over them, so a resumed,
   * re-attempted or half-pumped import reports the same numbers as a clean one.
   */
  async progress(organizationId: string, crmImportId: string): Promise<ImportProgress> {
    const [imported] = await this.db
      .select({
        status: crmImports.status,
        workflowRunId: crmImports.workflowRunId,
        revertWorkflowRunId: crmImports.revertWorkflowRunId,
        revertDeadlineAt: crmImports.revertDeadlineAt,
      })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");

    const undoing = imported.status === "reverting" || imported.status === "reverted";

    const [counts] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${crmImportRows.committedAt} is not null)::int`,
        reverted: sql<number>`count(*) filter (where ${crmImportRows.revertedAt} is not null)::int`,
        created: sql<number>`count(*) filter (where ${crmImportRows.createdPartyId} is not null)::int`,
        updated: sql<number>`count(*) filter (where ${crmImportRows.previous} is not null)::int`,
        review: sql<number>`count(*) filter (where ${crmImportRows.dataQualityFindingId} is not null)::int`,
        merged: sql<number>`count(*) filter (where ${crmImportRows.action} = 'merge' and ${crmImportRows.committedAt} is not null and ${crmImportRows.error} is null)::int`,
        skipped: sql<number>`count(*) filter (where ${crmImportRows.action} = 'skip' and ${crmImportRows.committedAt} is not null and ${crmImportRows.error} is null)::int`,
        failed: sql<number>`count(*) filter (where ${crmImportRows.error} is not null)::int`,
      })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
        ),
      );

    const tally = counts ?? {
      total: 0,
      done: 0,
      reverted: 0,
      created: 0,
      updated: 0,
      review: 0,
      merged: 0,
      skipped: 0,
      failed: 0,
    };

    const workflowRunId = undoing ? imported.revertWorkflowRunId : imported.workflowRunId;
    const [run] = workflowRunId
      ? await this.db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.organizationId, organizationId),
              eq(workflowRuns.workflowRunId, workflowRunId),
            ),
          )
          .limit(1)
      : [];

    return {
      crmImportId,
      status: imported.status,
      workflowRunId,
      runStatus: run?.status ?? null,
      complete:
        imported.status === "committed" ||
        imported.status === "reverted" ||
        imported.status === "failed",
      total: tally.total,
      // During an undo the outstanding work is what was written and not yet put
      // back; before one it is what has not been reached.
      remaining: undoing ? tally.done - tally.reverted : tally.total - tally.done,
      created: tally.created,
      updated: tally.updated,
      merged: tally.merged,
      review: tally.review,
      skipped: tally.skipped,
      failed: tally.failed,
      reverted: tally.reverted,
      revertDeadlineAt: imported.revertDeadlineAt,
    };
  }

  // ── One row ───────────────────────────────────────────────────────────────

  /**
   * One row of the file, inside its own savepoint.
   *
   * Everything here writes through `tx` rather than `this.db`: `this.db` is the
   * step's ambient transaction, and a write that went there would survive the
   * savepoint's rollback and leave half a row behind.
   */
  private async commitRow(
    tx: TenantTx,
    organizationId: string,
    crmImportId: string,
    rowId: string,
    filename: string | null,
  ): Promise<keyof BatchOutcome | null> {
    /**
     * Claim first, and in this savepoint.
     *
     * `committed_at IS NULL` is the whole idempotence guarantee: a re-run step
     * and a concurrent second run both find nothing to claim and do nothing.
     * Postgres takes a row lock here, so a second claimer blocks until this
     * savepoint's transaction resolves and then sees the truth rather than a
     * stale read.
     */
    const [row] = await tx
      .update(crmImportRows)
      .set({ committedAt: new Date() })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
          isNull(crmImportRows.committedAt),
        ),
      )
      .returning();

    // Somebody else has this row. Not an error, and not counted twice.
    if (!row) return null;

    const values = row.values ?? {};

    if (row.action === "skip") return "skipped";

    // Its values were folded into the row it repeats while the plan was made,
    // so there is nothing left for it to write. The record that it happened is
    // `duplicate_of_row`, which the preview already showed.
    if (row.action === "merge") return "merged";

    if (row.action === "review") {
      await this.fileUncertainty(tx, organizationId, crmImportId, row, filename);
      return "review";
    }

    if (row.action === "create") {
      const [party] = await tx
        .insert(businessParties)
        .values({
          organizationId,
          name: values.name ?? "",
          legalName: values.legalName ?? null,
          displayName: values.displayName ?? null,
          email: values.email ?? null,
          phone: values.phone ?? null,
          website: values.website ?? null,
          taxNumber: values.taxNumber ?? null,
          notes: values.notes ?? null,
          /**
           * The file's answer, not a constant.
           *
           * `partyType` and `status` are mapped columns with synonyms, so a
           * file whose Type column says VENDOR is previewed as VENDOR — and
           * hard-coding CUSTOMER here turned a supplier list into a customer
           * list, which is the preview-versus-commit divergence this module
           * exists to prevent. Checked again rather than trusted: `values` is
           * stored JSONB and may have been planned before the enum was.
           * `undefined` leaves the column's own default in place.
           */
          partyType: isPartyType(values.partyType) ? values.partyType : undefined,
          status: values.status || undefined,
          customFields: row.customFields ?? null,
        })
        .returning({
          partyId: businessParties.partyId,
          email: businessParties.email,
          phone: businessParties.phone,
          whatsappPhone: businessParties.whatsappPhone,
        });

      if (!party) throw new Error("insert returned no row");

      /**
       * The identifiers the new party is reachable at, claimed here.
       *
       * `applyPartyPatch` claims on every update, so the update path above is
       * already covered — but this insert writes `business_parties` directly and
       * would otherwise be the one uncovered path in the codebase. An imported
       * party whose e-mail address nothing had claimed matches no inbound
       * channel at all, which is exactly the record a tenant most wants matched:
       * the one they just migrated in.
       */
      await claimIdentifiers(
        tx,
        organizationId,
        party.partyId,
        identifierClaimsOfColumns(party),
      );

      await tx
        .update(crmImportRows)
        .set({ createdPartyId: party.partyId })
        .where(
          and(
            eq(crmImportRows.organizationId, organizationId),
            eq(crmImportRows.crmImportRowId, rowId),
          ),
        );

      return "created";
    }

    if (!row.matchedPartyId) throw new Error("an update row with nothing to update");

    const [before] = await tx
      .select()
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, row.matchedPartyId),
        ),
      )
      .limit(1);

    if (!before) throw new Error("the matched party no longer exists");

    /**
     * Only fills gaps.
     *
     * An import is somebody else's export, and overwriting a value a person
     * curated here with a staler one from another system is the complaint
     * this avoids. A blank stays blank until the file has something for it.
     *
     * A column's default counts as blank. `party_type` and `status` are NOT
     * NULL with defaults, so their `current` is never empty and the rule above
     * would never fill either — leaving two advertised import fields silently
     * unfillable on every update row.
     */
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (!value) continue;
      // An enum column takes the values the enum has and no others, whatever an
      // older stored plan may hold.
      if (key === "partyType" && !isPartyType(value)) continue;

      const current = (before as unknown as Record<string, unknown>)[key];
      const untouched =
        current === null ||
        current === undefined ||
        current === "" ||
        current === COLUMN_DEFAULTS[key];

      if (untouched) patch[key] = value;
    }

    // The import matched an existing party, which may already answer for a lead,
    // a client or a contact; those rows are derived from it and have to move with
    // it inside this row's savepoint.
    await updatePartyWithMirror(tx, organizationId, row.matchedPartyId, {
      ...patch,
      customFields: { ...(before.customFields ?? {}), ...(row.customFields ?? {}) },
    });

    await tx
      .update(crmImportRows)
      .set({ previous: before as unknown as Record<string, unknown> })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
        ),
      );

    return "updated";
  }

  /**
   * A row the scorer would not commit to, filed as somebody's job.
   *
   * The upsert is written here rather than borrowed from
   * `DataQualityProducersService` for one reason that is not stylistic: that
   * service files through its ambient `this.db`, and this has to land inside
   * *this row's* savepoint through the explicit `tx` — a finding written outside
   * the savepoint would survive a row that rolled back, and the row would be
   * retried and file a second one. The parts that must not diverge — the
   * severity band, the group key and the reversibility class — all come from
   * `data-quality`'s own pure modules, so the two producers cannot disagree
   * about the same pair of records.
   *
   * `ON CONFLICT` targets the partial unique over OPEN findings, so re-importing
   * a corrected spreadsheet refreshes the question rather than asking it twice.
   * Postgres only infers a partial unique when the predicate is repeated, which
   * is what `targetWhere` is; without it this raises 42P10 rather than silently
   * missing.
   */
  private async fileUncertainty(
    tx: TenantTx,
    organizationId: string,
    crmImportId: string,
    row: typeof crmImportRows.$inferSelect,
    filename: string | null,
  ): Promise<void> {
    if (!row.matchedPartyId || !row.match)
      throw new Error("a review row with nothing recorded about why");

    const finding = uncertaintyFinding({
      crmImportId,
      rowNumber: row.rowNumber,
      matchedPartyId: row.matchedPartyId,
      match: row.match as RowMatch,
      values: row.values ?? {},
      reason: row.reason,
      sourceFilename: filename,
    });

    const now = new Date();
    const [filed] = await tx
      .insert(dataQualityFindings)
      .values({ organizationId, ...finding, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [
          dataQualityFindings.organizationId,
          dataQualityFindings.producer,
          dataQualityFindings.findingKind,
          dataQualityFindings.subjectKey,
        ],
        targetWhere: sql`status = 'open'`,
        set: {
          lastSeenAt: now,
          severity: sql`excluded.severity`,
          groupKey: sql`excluded.group_key`,
          evidence: sql`excluded.evidence`,
          score: sql`excluded.score`,
          proposedAction: sql`excluded.proposed_action`,
          reversibility: sql`excluded.reversibility`,
        },
      })
      .returning({ findingId: dataQualityFindings.findingId });

    if (!filed) throw new Error("the data-quality queue accepted nothing for this row");

    await tx
      .update(crmImportRows)
      .set({ dataQualityFindingId: filed.findingId })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, row.crmImportRowId),
        ),
      );
  }

  /**
   * One row, put back, inside its own savepoint.
   *
   * Restored from the before-image the commit captured rather than by working
   * out what changed — which is the same reason `party-merge.service` replays a
   * snapshot: inspecting the current state cannot tell a value the import filled
   * from one a person edited afterwards, and would silently discard the edit.
   */
  private async revertRow(
    tx: TenantTx,
    organizationId: string,
    rowId: string,
  ): Promise<"deleted" | "restored" | "dismissed" | null> {
    const [row] = await tx
      .update(crmImportRows)
      .set({ revertedAt: new Date() })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
          isNotNull(crmImportRows.committedAt),
          isNull(crmImportRows.revertedAt),
        ),
      )
      .returning();

    if (!row) return null;

    if (row.createdPartyId) {
      // Soft delete, as everywhere else: the row leaves the product without
      // leaving the database, so a wrong undo is itself recoverable.
      await softDeletePartyWithMirror(tx, organizationId, row.createdPartyId);
      return "deleted";
    }

    if (row.previous && row.matchedPartyId) {
      const before = row.previous;
      await updatePartyWithMirror(tx, organizationId, row.matchedPartyId, {
        name: String(before.name ?? ""),
        legalName: (before.legalName as string | null) ?? null,
        displayName: (before.displayName as string | null) ?? null,
        email: (before.email as string | null) ?? null,
        phone: (before.phone as string | null) ?? null,
        website: (before.website as string | null) ?? null,
        taxNumber: (before.taxNumber as string | null) ?? null,
        notes: (before.notes as string | null) ?? null,
        customFields: (before.customFields as Record<string, unknown> | null) ?? null,
        ...(isPartyType(before.partyType) ? { partyType: before.partyType } : {}),
        ...(typeof before.status === "string" ? { status: before.status } : {}),
      });
      return "restored";
    }

    if (row.dataQualityFindingId) {
      /**
       * The question goes away with the import that asked it.
       *
       * Closed as `dismissed` rather than `resolved`, because nothing was wrong
       * with the dataset — the import that noticed the resemblance has been
       * taken back. No `resolution_id`: that ledger records decisions a person
       * took in the queue, and writing one here would put a decision in it that
       * nobody made there.
       */
      await tx
        .update(dataQualityFindings)
        .set({ status: "dismissed", resolvedAt: new Date() })
        .where(
          and(
            eq(dataQualityFindings.organizationId, organizationId),
            eq(dataQualityFindings.findingId, row.dataQualityFindingId),
            eq(dataQualityFindings.status, "open"),
          ),
        );
      return "dismissed";
    }

    // A skipped row, a folded row, or one that failed: nothing was written for
    // it, so there is nothing to put back.
    return null;
  }

  // ── Reads the phases share ────────────────────────────────────────────────

  private async extentOf(organizationId: string, crmImportId: string): Promise<PhaseExtent> {
    const [extent] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        maxRowNumber: sql<number>`coalesce(max(${crmImportRows.rowNumber}), 0)::int`,
      })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
        ),
      );

    return {
      settled: false,
      total: extent?.total ?? 0,
      maxRowNumber: extent?.maxRowNumber ?? 0,
    };
  }

  private async filenameOf(organizationId: string, crmImportId: string): Promise<string | null> {
    const [imported] = await this.db
      .select({ sourceFilename: crmImports.sourceFilename })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    return imported?.sourceFilename ?? null;
  }

  /**
   * The parties this file could match, projected to what matters.
   *
   * Fetched by identifier rather than as the first ten thousand rows the table
   * happened to return. Postgres does not promise an order without one, and
   * that slice shifts as rows are updated and vacuumed — so the same file
   * previewed twice could plan a row as `update` on Monday and `create` on
   * Tuesday, and quietly grow a second copy of a customer. The determinism the
   * plan is tested for held only for tenants under the cap.
   *
   * `blockingKeysFor` explains why these four identifiers are sufficient rather
   * than merely convenient.
   */
  private async existingFingerprints(
    organizationId: string,
    keys: BlockingKeys,
  ): Promise<{ fingerprints: PartyFingerprint[]; truncated: boolean }> {
    const lookups = [
      { expression: NORMALISED.taxNumber, values: keys.taxNumbers },
      { expression: NORMALISED.email, values: keys.emails },
      { expression: NORMALISED.phone, values: keys.phones },
      { expression: NORMALISED.host, values: keys.hosts },
    ].filter((lookup) => lookup.values.length > 0);

    // A file with no identifier in it cannot match anything, so there is
    // nothing to compare against and no query worth issuing.
    if (lookups.length === 0) return { fingerprints: [], truncated: false };

    const found = new Map<string, PartyFingerprint>();
    const passes = Math.max(
      ...lookups.map((lookup) => Math.ceil(lookup.values.length / KEYS_PER_QUERY)),
    );

    for (let pass = 0; pass < passes && found.size <= MAX_CANDIDATES; pass += 1) {
      const conditions = lookups
        .map((lookup) => ({
          expression: lookup.expression,
          slice: lookup.values.slice(pass * KEYS_PER_QUERY, (pass + 1) * KEYS_PER_QUERY),
        }))
        .filter((lookup) => lookup.slice.length > 0)
        .map((lookup) => inArray(lookup.expression, [...lookup.slice]));

      if (conditions.length === 0) continue;

      const rows = await this.db
        .select({
          partyId: businessParties.partyId,
          name: businessParties.name,
          legalName: businessParties.legalName,
          email: businessParties.email,
          phone: businessParties.phone,
          taxNumber: businessParties.taxNumber,
          website: businessParties.website,
        })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, organizationId),
            isNull(businessParties.deletedAt),
            or(...conditions),
          ),
        )
        // One past the ceiling, so "there are more" is known rather than guessed.
        .limit(MAX_CANDIDATES + 1 - found.size);

      for (const party of rows) found.set(party.partyId, party);
    }

    return {
      fingerprints: [...found.values()].slice(0, MAX_CANDIDATES),
      truncated: found.size > MAX_CANDIDATES,
    };
  }
}

/**
 * A person's answers to the columns the system would not guess.
 *
 * Applied to the mapping rather than remembered separately, so there is one
 * description of what each column means by the time anything is planned.
 */
function applyOverrides(
  columns: MappedColumn[],
  overrides: Readonly<Record<string, string>> | undefined,
): MappedColumn[] {
  const answered = !overrides
    ? columns
    : columns.map((column): MappedColumn => {
        const answer = overrides[column.header];
        if (!answer) return column;
        if (answer === "__ignore__")
          return { header: column.header, mapping: { kind: "unmapped" } };

        // Narrowed rather than asserted. The preview DTO enumerates these, so
        // every answer arriving today is a field — but "safe because one caller
        // validates it" is the coupling that breaks in silence when a second
        // caller appears.
        if (!isImportField(answer))
          throw new ConflictException(`"${answer}" is not a field this import can fill.`);

        return {
          header: column.header,
          // A person's answer is certain by definition; that is what asking was for.
          mapping: { kind: "mapped", field: answer, confidence: 1 },
        };
      });

  /**
   * `mapColumns` refuses to map one field twice, but it runs before these
   * answers are applied and an answer names a field outright — so two columns
   * can still end up claiming `name`, and the rightmost would silently win for
   * every row of the file. Asking again is pointless when the answer to the
   * question caused it, so this is a refusal with the way out in it.
   */
  const [collision] = duplicateFieldAssignments(answered);
  if (collision)
    throw new ConflictException(
      `"${collision.headers.join('" and "')}" are both set to ${collision.field}. ` +
        `One field can only be filled from one column — set the others to "__ignore__" or give them a field of their own.`,
    );

  return answered;
}
