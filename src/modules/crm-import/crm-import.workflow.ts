import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { WorkflowRegistry } from "../../common/workflow";
import type { JsonValue, StepContext, WorkflowRunContext } from "../../common/workflow";
import { CrmImportService, type BatchOutcome, type PhaseExtent } from "./crm-import.service";
import { ATTEMPT_BUDGET_MS, batchStepName, pauseStepName, rowWindows } from "./import-batches";
import { COMMIT_WORKFLOW, REVERT_WORKFLOW } from "./import-workflow-names";

export { COMMIT_WORKFLOW, REVERT_WORKFLOW } from "./import-workflow-names";

/**
 * Committing an import, and taking it back, durably.
 *
 * A large file is minutes of writes, and a deploy in the middle of one must not
 * leave half a customer list imported with no record of where it stopped.
 *
 * ── Why this is a step per batch and not one step ──────────────────────────
 *
 * The obvious shape — `step.run("commit", () => service.commit(...))` — buys
 * nothing, and the previous version of this file said so rather than pretending
 * otherwise. Each step gets its own transaction, so the whole file in one step
 * is the whole file in one transaction: a step that runs out of time rolls back
 * every `committed_at` it wrote, and all five attempts hit the same ceiling from
 * the same starting line. Durability is only real at the granularity of the
 * memo, so the memo has to be smaller than the thing that fails.
 *
 * A batch is therefore one step, one transaction and one memo. `commit-batch-7`
 * is rows 701–800 of this file for the life of the run, whatever else has
 * happened, because `rowWindows` cuts on row numbers rather than on an offset
 * into the shrinking set of outstanding rows. Boundaries derived from what is
 * left would move as rows commit, and a memo would then stand for work it never
 * did.
 *
 * ── Three properties this body must have, and how each is met ──────────────
 *
 * **A step re-runs when its previous attempt FAILED.** Only COMPLETED is
 * memoised. So `beginCommit` is a conditional update, `finishCommit` is guarded
 * on the status it changes, and every row inside a batch is claimed with
 * `committed_at IS NULL` before it is written. Re-running any step is a no-op
 * for the work already done.
 *
 * **A sleep releases the run and re-claims it later.** Anything captured in a
 * closure before a sleep may be stale afterwards — so nothing is. The extent is
 * re-read from the memo of `begin`, and each batch re-reads its own rows.
 *
 * **The handler re-executes from the top every attempt.** Everything with an
 * effect is inside a step; the loop, the arithmetic and the budget check are
 * not, and are cheap to redo.
 */
@Injectable()
export class CrmImportWorkflow implements OnModuleInit {
  private readonly logger = new Logger("CrmImport");

  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly imports: CrmImportService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: COMMIT_WORKFLOW,
      /** Suspensions do not spend one, so these are five genuine failures. */
      maxAttempts: 5,
      handler: (step, context) => this.commit(step, context),
    });

    this.registry.register({
      name: REVERT_WORKFLOW,
      maxAttempts: 5,
      handler: (step, context) => this.revert(step, context),
    });
  }

  private async commit(step: StepContext, context: WorkflowRunContext): Promise<JsonValue> {
    const crmImportId = requiredInput(context, "crmImportId");
    /**
     * When THIS attempt started.
     *
     * A local, because that is what it is: the budget belongs to this attempt in
     * this process, and anything persisted would make a resumed run inherit a
     * budget somebody else already spent. Replaying memos costs nothing against
     * it, so a resumed run is not charged for the work it already did.
     */
    const startedAt = Date.now();

    const extent = await step.run("commit-begin", () =>
      this.imports.beginCommit(context.organizationId, crmImportId),
    );

    if (extent.settled) return { crmImportId, settled: true };

    const total = await this.walk(step, extent, startedAt, (window) =>
      this.imports.commitBatch(context.organizationId, crmImportId, window),
    );

    await step.run("commit-finish", async () => {
      await this.imports.finishCommit(context.organizationId, crmImportId);
      this.logger.log(
        `import ${crmImportId}: ${String(total.created)} created, ${String(total.updated)} updated, ` +
          `${String(total.merged)} merged, ${String(total.review)} held for review, ` +
          `${String(total.skipped)} skipped, ${String(total.failed)} failed`,
      );
    });

    return { crmImportId, ...total };
  }

  private async revert(step: StepContext, context: WorkflowRunContext): Promise<JsonValue> {
    const crmImportId = requiredInput(context, "crmImportId");
    const userId = String(context.input.userId ?? "system");
    const startedAt = Date.now();

    const extent = await step.run("revert-begin", () =>
      this.imports.beginRevert(context.organizationId, crmImportId),
    );

    if (extent.settled) return { crmImportId, settled: true };

    /**
     * Backwards, because a later row may have updated a party an earlier row
     * created. Undone in file order, the update's before-image would be written
     * onto a party that is about to be soft-deleted, and the delete would then
     * be reverting a record the file no longer describes.
     */
    let deleted = 0;
    let restored = 0;
    let dismissed = 0;
    let failed = 0;

    for (const window of rowWindows(extent.maxRowNumber).reverse()) {
      if (await pauseIfSpent(step, "revert", window.index, startedAt)) continue;

      const outcome = await step.run(batchStepName("revert", window.index), () =>
        this.imports.revertBatch(context.organizationId, crmImportId, window),
      );

      deleted += outcome.deleted;
      restored += outcome.restored;
      dismissed += outcome.dismissed;
      failed += outcome.failed;
    }

    await step.run("revert-finish", async () => {
      await this.imports.finishRevert(context.organizationId, crmImportId, userId);
      this.logger.log(
        `import ${crmImportId} taken back: ${String(deleted)} deleted, ${String(restored)} restored, ` +
          `${String(dismissed)} questions closed, ${String(failed)} failed`,
      );
    });

    return { crmImportId, deleted, restored, dismissed, failed };
  }

  /**
   * Walks every window, pausing when this attempt's budget is spent.
   *
   * The tally is accumulated from the steps' own outputs, which is why they
   * return one: a resumed attempt replays each memo and arrives at the finish
   * with the same totals as the attempt that did the work, without re-counting
   * anything in the database.
   */
  private async walk(
    step: StepContext,
    extent: PhaseExtent,
    startedAt: number,
    run: (window: { index: number; fromRow: number; toRow: number }) => Promise<BatchOutcome>,
  ): Promise<BatchOutcome> {
    const total = {
      created: 0,
      updated: 0,
      merged: 0,
      review: 0,
      skipped: 0,
      failed: 0,
    };

    for (const window of rowWindows(extent.maxRowNumber)) {
      if (await pauseIfSpent(step, "commit", window.index, startedAt)) continue;

      const outcome = await step.run(batchStepName("commit", window.index), () => run(window));

      total.created += outcome.created;
      total.updated += outcome.updated;
      total.merged += outcome.merged;
      total.review += outcome.review;
      total.skipped += outcome.skipped;
      total.failed += outcome.failed;
    }

    return total;
  }
}

/**
 * Releases the run when this attempt has done enough.
 *
 * `sleep(0)` rather than a real delay: the point of suspending is to end this
 * transaction, this lease and this request — not to wait — so the run should
 * come back the moment anything is willing to claim it. On the attempt that
 * takes the pause, `sleep` throws `WorkflowSuspended` and this never returns;
 * `true` is reached only on the replay afterwards, where the pause is a
 * completed memo the loop walks straight past.
 *
 * A pause is named for the window it precedes, so the name is unique within the
 * run however many attempts it takes. WHICH windows get one depends on how fast
 * the machine was, and that is harmless: a name is only ever attached to one
 * decision, and an already-elapsed pause is skipped.
 */
async function pauseIfSpent(
  step: StepContext,
  phase: "commit" | "revert",
  index: number,
  startedAt: number,
): Promise<boolean> {
  if (Date.now() - startedAt < ATTEMPT_BUDGET_MS) return false;

  await step.sleep(pauseStepName(phase, index), 0);
  return true;
}

function requiredInput(context: WorkflowRunContext, key: string): string {
  const value = String(context.input[key] ?? "");
  if (!value) throw new Error(`import: run started without a ${key}`);
  return value;
}
