import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { dataQualityFindings, dataQualityResolutions } from "../../db/schema";
import type { ReversibilityClass } from "../../db/schema/crm/autonomous-decisions";
import { PartyMergeService } from "../party/party-merge.service";
import { DataQualityQueueService } from "./data-quality-queue.service";
import { DataQualityHealthService } from "./dataset-health.service";
import { strictestReversibility } from "./finding-vocabulary";
import {
  MAX_RECORDED_FAILURES,
  applyAll,
  type ClaimedFinding,
  type FindingExecutorDeps,
} from "./lib/finding-executors";
import { reverseResolution, type ResolutionUndoDeps } from "./lib/resolution-undo";
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
 * That per-item remediation now lives in `lib/finding-executors.ts`, and the
 * undo in `lib/resolution-undo.ts`. The isolation is `withSavepoint`, and it is
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

  private get executorDeps(): FindingExecutorDeps {
    return { db: this.db, merges: this.merges, logger: this.logger };
  }

  private get undoDeps(): ResolutionUndoDeps {
    return { db: this.db, health: this.health, logger: this.logger };
  }

  // ── One decision ──────────────────────────────────────────────────────────

  /**
   * Resolve a selection of findings as a single decision.
   *
   * The claim is a conditional set-based update: `status = 'open'` sits in its
   * predicate, so two people deciding about overlapping selections at the same
   * instant each take the rows the other has not, and neither fails. A read-then-
   * write would let both believe they had all four hundred.
   */
  async resolve(organizationId: string, userId: string, input: ResolveFindingsInput) {
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

    const [resolution] = await this.db
      .insert(dataQualityResolutions)
      .values({
        organizationId,
        action: input.action,
        selectionKind: input.selection.kind,
        groupKey: input.selection.kind === "group" ? input.selection.groupKey : null,
        reversibility,
        reason: input.reason ?? null,
        attemptedCount: candidates.length,
        // Filled in once the executors have run; the row has to exist first
        // because every claimed finding carries a foreign key to it.
        resolvedCount: 0,
        decidedByUserId: userId,
      })
      .returning({ resolutionId: dataQualityResolutions.resolutionId });

    if (!resolution) throw new ConflictException("The decision could not be recorded");

    const claimed = await this.claim(
      organizationId,
      userId,
      resolution.resolutionId,
      candidates.map((row) => row.findingId),
      input.action === "dismiss" ? "dismissed" : "resolved",
    );

    const failures =
      input.action === "apply"
        ? await applyAll(this.executorDeps, organizationId, userId, claimed)
        : [];

    const failedIds = new Set(failures.map((failure) => failure.findingId));
    const resolvedCount = claimed.length - failedIds.size;

    await this.db
      .update(dataQualityResolutions)
      .set({
        resolvedCount,
        failedCount: failedIds.size,
        failures: failures.length > 0 ? failures.slice(0, MAX_RECORDED_FAILURES) : null,
      })
      .where(
        and(
          eq(dataQualityResolutions.organizationId, organizationId),
          eq(dataQualityResolutions.resolutionId, resolution.resolutionId),
        ),
      );

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
      resolutionId: resolution.resolutionId,
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

  /** One statement, whatever the size of the selection. */
  private async claim(
    organizationId: string,
    userId: string,
    resolutionId: string,
    findingIds: string[],
    status: "resolved" | "dismissed",
  ): Promise<ClaimedFinding[]> {
    if (findingIds.length === 0) return [];

    return this.db
      .update(dataQualityFindings)
      .set({
        status,
        resolvedAt: new Date(),
        resolvedByUserId: userId,
        resolutionId,
        lastError: null,
      })
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.status, "open"),
          inArray(dataQualityFindings.findingId, findingIds),
        ),
      )
      .returning({
        findingId: dataQualityFindings.findingId,
        proposedAction: dataQualityFindings.proposedAction,
        partyId: dataQualityFindings.partyId,
        relatedPartyId: dataQualityFindings.relatedPartyId,
      });
  }

  // ── Taking it back ────────────────────────────────────────────────────────

  /** See `lib/resolution-undo.ts`: the refusal, not the undo, is the feature. */
  reverse(
    organizationId: string,
    userId: string,
    resolutionId: string,
    input: ReverseResolutionInput,
  ) {
    return reverseResolution(this.undoDeps, organizationId, userId, resolutionId, input);
  }
}
