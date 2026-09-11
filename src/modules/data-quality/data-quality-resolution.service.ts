import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import type { ReversibilityClass } from "../../db/schema/crm/autonomous-decisions";
import { PartyMergeService } from "../party/party-merge.service";
import { DataQualityQueueService } from "./data-quality-queue.service";
import { DataQualityHealthService } from "./dataset-health.service";
import { strictestReversibility } from "./finding-vocabulary";
import {
  MAX_RECORDED_FAILURES,
  claimReversal,
  loadDecision,
  openDecision,
  recordDecisionOutcome,
  recordReversedCount,
} from "./data-quality-decision-record";
import {
  assertFindingsInOrg,
  claimFindings,
  listClosedForResolution,
  reopenFindings,
} from "./data-quality-finding-claim";
import { applyAll, type ExecutionFailure } from "./data-quality-remediation";
import { type ResolveFindingsInput, type ReverseResolutionInput } from "./dto/data-quality.schemas";

/**
 * Deciding about many findings at once, and taking that decision back.
 *
 * The shape of this file is the ticket's fourth criterion made structural. A
 * bulk resolution is **one decision row**, **one claim statement** and **one
 * reopen statement**, whatever the size of the selection — it is not the
 * single-item path in a `for`. The only thing that runs per item is a
 * remediation that is irreducibly per item, and each of those gets a savepoint
 * so item seven failing costs item seven.
 *
 * That per-item remediation lives in `data-quality-remediation.ts`, the claim
 * and reopen statements in `data-quality-finding-claim.ts`, and the decision row
 * in `data-quality-decision-record.ts`. The isolation is `withSavepoint`, and it is
 * subtler than it looks — see `savepoint.ts` for why a nested service would
 * otherwise write straight past the savepoint it appears to be inside.
 */
@Injectable()
export class DataQualityResolutionService {
  private readonly logger = new Logger("DataQualityResolution");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queue: DataQualityQueueService,
    private readonly merges: PartyMergeService,
    private readonly health: DataQualityHealthService,
  ) {}

  /**
   * Resolve a selection of findings as a single decision.
   *
   * The claim is a conditional set-based update, so two people deciding about
   * overlapping selections at the same instant each take the rows the other has
   * not, and neither fails.
   */
  async resolve(organizationId: string, userId: string, input: ResolveFindingsInput) {
    if (input.selection.kind === "ids")
      await assertFindingsInOrg(this.db, organizationId, input.selection.findingIds);
    const candidates = await this.queue.selectCandidates(organizationId, input.selection, "open");

    /**
     * Nothing matched. Not-found rather than an empty success, and deliberately
     * the same answer for another tenant's identifiers as for identifiers that
     * never existed — a 403 here would confirm the findings exist.
     */
    if (candidates.length === 0)
      throw new NotFoundException("No open findings matched this selection");

    /**
     * What the person believed they were deciding about.
     *
     * Compared before anything is written, because the whole hazard of a bulk
     * action is that the set moved between the screen and the click.
     */
    if (input.expectedCount !== undefined && input.expectedCount !== candidates.length)
      throw new ConflictException(
        `This selection now covers ${candidates.length} findings, not ${input.expectedCount}. Reload and check before deciding.`,
      );

    /**
     * A dismissal touches no record, so it is instantly reversible however
     * irreversible the actions it declined to take would have been. An
     * application inherits the strictest class in the selection, because a batch
     * can only be undone as far as its least reversible member allows.
     */
    const reversibility: ReversibilityClass =
      input.action === "dismiss"
        ? "instant"
        : strictestReversibility(candidates.map((row) => row.reversibility));

    const resolutionId = await openDecision(this.db, {
      organizationId,
      action: input.action,
      selectionKind: input.selection.kind,
      groupKey: input.selection.kind === "group" ? input.selection.groupKey : null,
      reversibility,
      reason: input.reason ?? null,
      attemptedCount: candidates.length,
      decidedByUserId: userId,
    });

    const claimed = await claimFindings(this.db, {
      organizationId,
      userId,
      resolutionId,
      findingIds: candidates.map((row) => row.findingId),
      status: input.action === "dismiss" ? "dismissed" : "resolved",
    });

    const remediation = { db: this.db, merges: this.merges, logger: this.logger };
    const failures =
      input.action === "apply" ? await applyAll(remediation, organizationId, userId, claimed) : [];

    const failedIds = new Set(failures.map((failure) => failure.findingId));
    const resolvedCount = claimed.length - failedIds.size;

    await recordDecisionOutcome(this.db, organizationId, resolutionId, {
      resolvedCount,
      failedCount: failedIds.size,
      failures: failures.length > 0 ? failures.slice(0, MAX_RECORDED_FAILURES) : null,
    });

    /**
     * The dataset-health number, re-read now that the queue is shorter.
     *
     * Here rather than on a schedule, because this is the moment it changed. A
     * number captured nightly would credit a morning's triage to whatever else
     * happened that day, and a tenant that worked its queue and looked would see
     * nothing move — which is the exact failure the trend exists to rule out.
     */
    await this.health.captureQuietly(organizationId);

    return {
      resolutionId,
      action: input.action,
      reversibility,
      attemptedCount: candidates.length,
      resolvedCount,
      failedCount: failedIds.size,
      failures: failures.slice(0, MAX_RECORDED_FAILURES),
      /**
       * How much of the group one decision did not reach. Reported rather than
       * assumed, so nobody reads "resolved 400" as "the group is empty".
       */
      remainingInGroup:
        input.selection.kind === "group"
          ? await this.queue.countOpenInGroup(organizationId, input.selection.groupKey)
          : null,
    };
  }

  /**
   * Undo one decision, if its reversibility class allows it.
   *
   * The refusal is the feature. `planResolutionReversal` decides, and it refuses
   * `irreversible` outright rather than attempting a remedy that cannot work —
   * offering the button anyway teaches people that undo works when it does not.
   */
  async reverse(
    organizationId: string,
    userId: string,
    resolutionId: string,
    input: ReverseResolutionInput,
  ) {
    const resolution = await loadDecision(this.db, organizationId, resolutionId);
    if (!resolution) throw new NotFoundException("Decision not found");

    const plan = planResolutionReversal(
      {
        action: resolution.action,
        reversibility: resolution.reversibility,
        holdUntil: resolution.holdUntil,
        reversedAt: resolution.reversedAt,
        resolvedCount: resolution.resolvedCount,
      },
      new Date(),
    );

    if (!plan.ok) throw new ConflictException(plan.explanation);

    const claimed = await claimReversal(
      this.db,
      organizationId,
      resolutionId,
      userId,
      input.reason ?? null,
    );
    if (!claimed)
      throw new ConflictException("This decision was reversed by someone else a moment ago.");

    const closed = await listClosedForResolution(this.db, organizationId, resolutionId);

    const reopenable: string[] = [];
    const failures: ExecutionFailure[] = [];

    for (const finding of closed) {
      const partyMergeId = finding.undoToken?.["partyMergeId"];

      /**
       * Nothing was done to a record, so reopening the finding is the whole
       * undo. A dismissal is always this case, which is why the planner names it
       * separately rather than dispatching a no-op per item.
       */
      if (plan.action === "reopen" || typeof partyMergeId !== "string") {
        reopenable.push(finding.findingId);
        continue;
      }

      failures.push({ findingId: finding.findingId, error: "merge revert is not supported" });
      this.logger.warn(`merge ${partyMergeId} cannot be reverted: capability is not implemented`);
    }

    /**
     * Only what actually came back is reopened. A finding whose merge could not
     * be undone stays closed, because reopening it would claim a record was
     * restored when it was not — and the next sweep would then file a second
     * finding for a problem that is still fixed.
     */
    const reopened = await reopenFindings(this.db, organizationId, reopenable);

    await recordReversedCount(this.db, organizationId, resolutionId, reopened);

    // An undo puts findings back in the queue, so the number goes back up. A
    // trend that only ever recorded improvements would be a graph of decisions
    // taken rather than of the dataset.
    await this.health.captureQuietly(organizationId);

    return {
      reversed: true,
      action: plan.action,
      reopened,
      failedCount: failures.length,
      failures: failures.slice(0, MAX_RECORDED_FAILURES),
    };
  }
}
