import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import {
  crmImportRows,
  crmImports,
  dataQualityFindings,
  subjectTypes,
  workflowRuns,
} from "../../../db/schema";
import type { ImportStatus, StoredColumnMapping } from "../../../db/schema/crm/imports";
import { WorkflowRunnerService } from "../../../common/workflow";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { PartyFingerprint } from "../../party/party-duplicates";
import { mapColumns, needsConfirmation } from "./column-mapping";
import type { ImportEntity } from "./import-entities";
import {
  defaultPipelineId,
  existingFingerprints,
  MAX_CANDIDATES,
  partiesByName,
  subjectsByReference,
} from "./import-lookups";
import { applyOverrides } from "./import-overrides";
import { blockingKeysFor, lookupKeysFor, planImport, type RowMatch } from "./import-plan";
import { writerFor, type WriteContext } from "./writers";
import { uncertaintyFinding } from "./import-uncertainty";
import { COMMIT_WORKFLOW, REVERT_WORKFLOW } from "./import-workflow-names";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";

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

/**
 * What every row of one file has in common.
 *
 * Read once per batch. The entity is what decides which writer runs, and the
 * two identifiers are the things a writer cannot get from the row: a subject's
 * type and a deal's pipeline are properties of the import, not of the line.
 */
interface ImportContext {
  readonly entity: ImportEntity;
  readonly filename: string | null;
  readonly write: WriteContext;
}

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
    private readonly planLimits: PlanLimitsService,
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
    /** Which entity this file lands as. Every file before this column was a party. */
    entity?: ImportEntity;
    /** Required for, and only for, a subject import. */
    subjectTypeId?: string;
    headers: readonly string[];
    rows: readonly (readonly string[])[];
    /** A person's answers to ambiguous columns, from a previous preview. */
    overrides?: Readonly<Record<string, string>>;
  }) {
    if (input.rows.length > MAX_ROWS)
      throw new ConflictException(
        `That file has ${input.rows.length} rows; ${MAX_ROWS} is the most this import handles.`,
      );

    const entity = input.entity ?? "party";
    const subjectTypeId = await this.resolveSubjectType(
      input.organizationId,
      entity,
      input.subjectTypeId,
    );

    const columns = applyOverrides(entity, mapColumns(input.headers, entity), input.overrides);
    const unanswered = needsConfirmation(columns);

    /**
     * The party scorer runs for parties and nothing else.
     *
     * It is a weighted combination of several weak identifiers, and the weights
     * are calibrated against companies. Pointing it at deals or activities would
     * be a different claim entirely, so those entities say `none` and this asks
     * for no candidates at all rather than fetching a set nothing scores.
     */
    const candidates =
      entity === "party"
        ? await existingFingerprints(
            this.db,
            input.organizationId,
            blockingKeysFor(columns, input.rows),
          )
        : { fingerprints: [] as PartyFingerprint[], truncated: false };

    const keys = lookupKeysFor(entity, columns, input.rows);
    const plan = planImport({
      entity,
      columns,
      rows: input.rows,
      existing: candidates.fingerprints,
      existingByKey: await subjectsByReference(
        this.db,
        input.organizationId,
        subjectTypeId,
        keys.naturalKeys,
      ),
      anchors: await partiesByName(this.db, input.organizationId, keys.anchorKeys),
    });

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
        targetEntity: entity,
        targetSubjectTypeId: subjectTypeId,
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
      matchedRecordId: row.matchedRecordId ?? null,
      duplicateOfRow: row.duplicateOfRow ?? null,
      match: row.match ? { ...row.match, signals: [...row.match.signals] } : null,
    }));

    // Chunked, because five thousand rows of a dozen columns each is well past
    // the parameter limit one statement can carry.
    for (let index = 0; index < values.length; index += PLAN_INSERT_CHUNK)
      await this.db.insert(crmImportRows).values(values.slice(index, index + PLAN_INSERT_CHUNK));

    return {
      crmImportId: imported.id,
      entity,
      subjectTypeId,
      columns,
      needsConfirmation: unanswered,
      summary: plan.summary,
      warnings,
      // A sample, not the file. A preview that ships ten thousand rows to a
      // browser is a preview nobody waits for.
      rows: plan.rows.slice(0, 50),
    };
  }

  /**
   * Which subject type a subject import lands as, checked against this tenant.
   *
   * A 404 rather than a 403 for a type belonging to somebody else, because a 403
   * on another organisation's id confirms that the id exists. Checked here, at
   * preview, so a wrong choice is a sentence the person can act on rather than a
   * NOT NULL violation discovered on row four thousand of the commit.
   */
  private async resolveSubjectType(
    organizationId: string,
    entity: ImportEntity,
    subjectTypeId: string | undefined,
  ): Promise<string | null> {
    // Null for everything else, which is what `chk_crm_imports_subject_type`
    // requires: a party import carrying a subject type would mean the entity
    // changed after the plan was made.
    if (entity !== "subject") return null;

    if (!subjectTypeId)
      throw new BadRequestException(
        "A subject import has to say which subject type these rows are, because nothing in the file can.",
      );

    const [type] = await this.db
      .select({ subjectTypeId: subjectTypes.subjectTypeId })
      .from(subjectTypes)
      .where(
        and(
          eq(subjectTypes.organizationId, organizationId),
          eq(subjectTypes.subjectTypeId, subjectTypeId),
          isNull(subjectTypes.deletedAt),
        ),
      )
      .limit(1);

    if (!type) throw new NotFoundException("Subject type not found");
    return type.subjectTypeId;
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

  /**
   * Which entity this import writes, for a caller that has only its identifier.
   *
   * A 404 for an import belonging to somebody else, like every other read here:
   * a 403 on another organisation's id confirms the id exists.
   */
  async targetEntityOf(organizationId: string, crmImportId: string): Promise<ImportEntity> {
    const [imported] = await this.db
      .select({ targetEntity: crmImports.targetEntity })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");
    return imported.targetEntity;
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

    /*
      What the plan allows, asked once for the whole batch and before any row
      lands.

      An import is the easiest way to walk past a seat or record cap: it creates
      in bulk, from a file, with nobody watching. Asking per row would refuse
      halfway through and leave the tenant with a partial import, so the question
      is asked here -- against the rows still uncommitted, which is what a resumed
      commit would go on to create rather than what the file originally held.

      This guard existed before the importer moved to `crm/import/`; the move
      left it behind, and `party-creation-invariant.spec.ts` is what noticed.
    */
    const [creating] = await this.db
      .select({ rows: sql<number>`count(*)::int` })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
          eq(crmImportRows.action, "create"),
          isNull(crmImportRows.committedAt),
        ),
      );

    if (creating && creating.rows > 0) {
      await this.planLimits.assertWithinLimit(organizationId, "crmContacts", creating.rows);
    }

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

    // Read once per batch rather than per row: it is the same answer for every
    // row of a file, and it is what decides which writer runs.
    const context = await this.importContext(organizationId, crmImportId);
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
          this.commitRow(tx, organizationId, crmImportId, row.crmImportRowId, context),
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
    if (rows.length === 0) return tally;

    const context = await this.importContext(organizationId, crmImportId);

    for (const row of rows) {
      try {
        const outcome = await this.db.transaction((tx) =>
          this.revertRow(tx, organizationId, row.crmImportRowId, context),
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
        created: sql<number>`count(*) filter (where ${crmImportRows.createdRecordId} is not null)::int`,
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
    context: ImportContext,
  ): Promise<keyof BatchOutcome | null> {
    /**
     * Claim first, and in this savepoint — by locking the row, not by stamping it.
     *
     * `committed_at IS NULL` is the whole idempotence guarantee: a re-run step
     * and a concurrent second run both find nothing to claim and do nothing.
     * `FOR UPDATE` is what makes that safe rather than racy — Postgres takes the
     * row lock, a second claimer blocks until this savepoint's transaction
     * resolves, and then re-evaluates the predicate against the committed truth
     * rather than its own stale snapshot.
     *
     * This used to be an `UPDATE ... SET committed_at = now() ... RETURNING`,
     * which took the same lock and also marked the row done before it had done
     * anything. `chk_crm_import_rows_outcome` exists to say a committed row
     * records what it did, so it can be undone — and a `create` row stamped
     * before `created_record_id` is written fails that check on the claim
     * itself. A CHECK constraint cannot be deferred, so every `create`, `update`
     * and `review` row failed on its first statement; the batch caught the
     * violation, recorded it as the row's error, and reported the import as
     * committed with everything failed. Only `skip` and `merge` came through,
     * because the constraint exempts them.
     *
     * So `committed_at` is now stamped by `stamp` below, in the same statement
     * as the column that says what the row did.
     */
    const [row] = await tx
      .select()
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
          isNull(crmImportRows.committedAt),
        ),
      )
      .for("update");

    // Somebody else has this row. Not an error, and not counted twice.
    if (!row) return null;

    /** Done, and what it did, together — which is what the CHECK asks for. */
    const stamp = async (outcome: Partial<typeof crmImportRows.$inferInsert> = {}) => {
      await tx
        .update(crmImportRows)
        .set({ ...outcome, committedAt: new Date() })
        .where(
          and(
            eq(crmImportRows.organizationId, organizationId),
            eq(crmImportRows.crmImportRowId, rowId),
          ),
        );
    };

    if (row.action === "skip") {
      await stamp();
      return "skipped";
    }

    // Its values were folded into the row it repeats while the plan was made,
    // so there is nothing left for it to write. The record that it happened is
    // `duplicate_of_row`, which the preview already showed.
    if (row.action === "merge") {
      await stamp();
      return "merged";
    }

    if (row.action === "review") {
      // Writes `data_quality_finding_id` itself, so the row satisfies the CHECK
      // by the time it is stamped.
      await this.fileUncertainty(tx, organizationId, crmImportId, row, context.filename);
      await stamp();
      return "review";
    }

    /**
     * From here on the entity decides everything, and nothing else does.
     *
     * This is the seam the whole ticket is about: adding a fifth entity is a
     * writer and a vocabulary, not another branch in this method.
     */
    const writer = writerFor(context.entity);
    const planned = { values: row.values ?? {}, customFields: row.customFields ?? null };

    if (row.action === "create") {
      const recordId = await writer.create(tx, context.write, planned);
      await stamp({ createdRecordId: recordId });
      return "created";
    }

    if (!row.matchedRecordId) throw new Error("an update row with nothing to update");

    /**
     * Refused loudly rather than skipped quietly.
     *
     * An entity whose match strategy is `none` can never plan an `update`, so
     * this can only be a plan stored by older code against a different entity —
     * which is exactly when doing nothing and reporting success is worst.
     */
    const updates = writer.updates;
    if (!updates)
      throw new Error(`a ${context.entity} import cannot update an existing record`);

    const before = await updates.before(tx, context.write, row.matchedRecordId);
    if (!before) throw new Error("the matched record no longer exists");

    await updates.fillGaps(tx, context.write, row.matchedRecordId, before, planned);

    await stamp({ previous: before });

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
    if (!row.matchedRecordId || !row.match)
      throw new Error("a review row with nothing recorded about why");

    const finding = uncertaintyFinding({
      crmImportId,
      rowNumber: row.rowNumber,
      /**
       * Still a party, and that is not an assumption. `review` is produced only
       * by the fingerprint strategy, which only parties use, so the matched
       * record here is always a party — and the data-quality queue's duplicate
       * finding is about a pair of parties specifically.
       */
      matchedPartyId: row.matchedRecordId,
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
    context: ImportContext,
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

    const writer = writerFor(context.entity);

    if (row.createdRecordId) {
      // Soft delete, as everywhere else: the record leaves the product without
      // leaving the database, so a wrong undo is itself recoverable.
      await writer.remove(tx, context.write, row.createdRecordId);
      return "deleted";
    }

    if (row.previous && row.matchedRecordId) {
      const updates = writer.updates;
      if (!updates)
        throw new Error(`a ${context.entity} import has nothing to put a record back with`);

      await updates.restore(tx, context.write, row.matchedRecordId, row.previous);
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

  /**
   * Everything a batch needs that is the same for every row of the file.
   *
   * Read from the import rather than re-derived, for the reason the stored
   * mapping exists at all: the entity was decided when the tenant approved the
   * preview, and working it out again at commit time would let the commit be a
   * different import from the one they saw.
   */
  private async importContext(
    organizationId: string,
    crmImportId: string,
  ): Promise<ImportContext> {
    const [imported] = await this.db
      .select({
        sourceFilename: crmImports.sourceFilename,
        targetEntity: crmImports.targetEntity,
        targetSubjectTypeId: crmImports.targetSubjectTypeId,
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

    const entity = imported.targetEntity;

    return {
      entity,
      filename: imported.sourceFilename,
      write: {
        organizationId,
        subjectTypeId: imported.targetSubjectTypeId,
        pipelineId: entity === "pipeline" ? await defaultPipelineId(this.db, organizationId) : null,
      },
    };
  }

}
