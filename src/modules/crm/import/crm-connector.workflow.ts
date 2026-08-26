import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { WorkflowRegistry } from "../../../common/workflow";
import type { JsonValue, StepContext, WorkflowRunContext } from "../../../common/workflow";
import { ATTEMPT_BUDGET_MS, pauseStepName } from "./import-batches";
import {
  CrmConnectorService,
  MAX_PAGES_PER_WALK,
  type WalkExtent,
} from "./crm-connector.service";
import { CONNECTOR_SYNC_WORKFLOW } from "./import-workflow-names";

export { CONNECTOR_SYNC_WORKFLOW } from "./import-workflow-names";

/**
 * Walking somebody else's CRM, durably.
 *
 * The same three properties ticket 13's commit workflow has to hold, met the
 * same way, with one difference that is worth naming because it changes what a
 * step's name can mean.
 *
 * `commit-batch-7` is rows 701–800 of a file for the life of the run, because
 * `rowWindows` cuts on row numbers that were assigned once at preview. A
 * connector has no such coordinate: the provider decides what page two is, and
 * it decides by handing back a cursor. So `fetch-page-2` means "the third page
 * of THIS run's walk", and what makes that stable is that the walk always starts
 * from the same place within a run — `sync-begin`'s memo — and each page's memo
 * carries the request for the next one. A resumed attempt replays those memos
 * and arrives at exactly the frontier the previous attempt reached, without
 * re-issuing a single request.
 *
 * That is also why the cursor is carried in the step's OUTPUT rather than read
 * back from the row inside the loop. On a replay the step body does not run, so
 * a loop that re-read the row would read a cursor from the future — the one the
 * furthest-ahead attempt left — and skip every page in between.
 *
 * ── What a failure costs ───────────────────────────────────────────────────
 *
 * Nothing, by construction. A page's fetch, its staging and its cursor write are
 * one step and therefore one transaction; a failure rolls back all three, and
 * the retry re-reads a page that stages `ON CONFLICT DO NOTHING`. A rate limit
 * arrives here as an ordinary failure — `executeProxy` throws on 429 as it does
 * on any status at or above 400 — so the runtime's backoff is the rate-limit
 * policy, and the pages already read are not re-read while it waits.
 */
@Injectable()
export class CrmConnectorWorkflow implements OnModuleInit {
  private readonly logger = new Logger("CrmConnector");

  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly connectors: CrmConnectorService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: CONNECTOR_SYNC_WORKFLOW,
      /** Suspensions do not spend one, so these are five genuine failures. */
      maxAttempts: 5,
      handler: (step, context) => this.sync(step, context),
    });
  }

  private async sync(step: StepContext, context: WorkflowRunContext): Promise<JsonValue> {
    const crmConnectorSyncId = requiredInput(context, "crmConnectorSyncId");
    /**
     * When THIS attempt started. A local, because the budget belongs to this
     * attempt in this process — anything persisted would make a resumed run
     * inherit a budget somebody else already spent.
     */
    const startedAt = Date.now();

    const extent: WalkExtent = await step.run("sync-begin", () =>
      this.connectors.beginWalk(context.organizationId, crmConnectorSyncId),
    );

    if (extent.settled) {
      this.logger.log(`sync ${crmConnectorSyncId}: ${extent.reason ?? "nothing to do"}`);
      return { crmConnectorSyncId, settled: true, reason: extent.reason };
    }

    try {
      return await this.walk(step, context.organizationId, crmConnectorSyncId, extent, startedAt);
    } catch (error) {
      /**
       * Counted here rather than swallowed, and then re-thrown.
       *
       * The counter is what eventually stops a connector nobody is going to fix,
       * and the re-throw is what lets the runtime retry the ones that are
       * transient. Recording it must not look like handling it: the cursor and
       * the watermark are deliberately untouched, so the retry reads exactly the
       * page that failed.
       */
      await this.connectors.recordFailure(
        context.organizationId,
        crmConnectorSyncId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async walk(
    step: StepContext,
    organizationId: string,
    crmConnectorSyncId: string,
    extent: WalkExtent,
    startedAt: number,
  ): Promise<JsonValue> {
    /**
     * Out of `sync-begin`'s memo, so every attempt of this run agrees about
     * where the walk started — the persisted cursor if a previous run stopped
     * part-way, the stream's first request otherwise.
     */
    if (!extent.startAt) throw new Error("connector: a live walk with nowhere to start");
    let request = extent.startAt;

    let drained = false;
    let read = 0;

    for (let page = 0; page < MAX_PAGES_PER_WALK; page += 1) {
      if (await pauseIfSpent(step, page, startedAt)) continue;

      const outcome = await step.run(`fetch-page-${String(page)}`, () =>
        this.connectors.fetchPage(organizationId, crmConnectorSyncId, request),
      );

      read += outcome.staged;

      if (!outcome.next) {
        drained = true;
        break;
      }

      /**
       * Stopping because the import is full is NOT draining.
       *
       * The cursor stays where it is and the watermark does not move, so the
       * next sync continues this same collection from here and produces the next
       * import. A large account becomes several reviewable, separately
       * revertable imports rather than one that could not be previewed.
       */
      if (this.connectors.isFull(outcome.total)) break;

      request = outcome.next;
    }

    const result = await step.run("sync-finish", () =>
      this.connectors.finishWalk(organizationId, crmConnectorSyncId, drained),
    );

    this.logger.log(
      `sync ${crmConnectorSyncId}: ${String(read)} staged this attempt, ` +
        `${String(result.records)} imported, ${drained ? "drained" : "more to come"}` +
        `${result.watermarkAdvanced ? ", watermark advanced" : ", watermark held"}`,
    );

    return { crmConnectorSyncId, ...result };
  }
}

/**
 * Releases the run when this attempt has done enough.
 *
 * `sleep(0)` rather than a real delay, for the reason the import workflow gives:
 * the point of suspending is to end this transaction, this lease and this
 * request — not to wait. On the attempt that takes the pause, `sleep` throws
 * `WorkflowSuspended` and this never returns; `true` is reached only on the
 * replay afterwards, where the pause is a completed memo the loop walks past.
 */
async function pauseIfSpent(
  step: StepContext,
  page: number,
  startedAt: number,
): Promise<boolean> {
  if (Date.now() - startedAt < ATTEMPT_BUDGET_MS) return false;

  await step.sleep(pauseStepName("sync", page), 0);
  return true;
}

function requiredInput(context: WorkflowRunContext, key: string): string {
  const value = String(context.input[key] ?? "");
  if (!value) throw new Error(`connector: run started without a ${key}`);
  return value;
}
