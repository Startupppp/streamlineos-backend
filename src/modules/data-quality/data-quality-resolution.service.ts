import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { dataQualityFindings, dataQualityResolutions } from "../../db/schema";
import type { ReversibilityClass } from "../../db/schema/crm/autonomous-decisions";
import { PartyMergeService } from "../party/party-merge.service";
import { DataQualityQueueService } from "./data-quality-queue.service";
import { refuseIfContradicted } from "./merge-guard";
import { withSavepoint } from "./savepoint";
import { strictestReversibility } from "./finding-vocabulary";
import { planResolutionReversal } from "./resolution-reversal";
import {
  MAX_BULK,
  type ResolveFindingsInput,
  type ReverseResolutionInput,
} from "./dto/data-quality.schemas";

/** Enough failures for a person to see the pattern; not a second copy of the queue. */
const MAX_RECORDED_FAILURES = 50;

interface ClaimedFinding {
  findingId: string;
  proposedAction: string;
  partyId: string;
  relatedPartyId: string | null;
}

interface ExecutionFailure {
  findingId: string;
  error: string;
}

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
 * The isolation is `withSavepoint`, and it is subtler than it looks — see
 * `savepoint.ts` for why a nested service would otherwise write straight past
 * the savepoint it appears to be inside.
 */
@Injectable()
export class DataQualityResolutionService {
  private readonly logger = new Logger("DataQualityResolution");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queue: DataQualityQueueService,
    private readonly merges: PartyMergeService,
  ) {}

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
      input.action === "apply" ? await this.applyAll(organizationId, userId, claimed) : [];

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

  // ── Executors ─────────────────────────────────────────────────────────────

  /**
   * Perform what each claimed finding proposed.
   *
   * `none` is the common case and costs nothing: most findings exist so a person
   * looks at a record, and there is no safe automatic remedy to run. Only
   * `merge-parties` executes, and merging is irreducibly pairwise — there is no
   * set-based statement that merges four hundred pairs — so it is the one thing
   * here that iterates, and every iteration is isolated.
   */
  private async applyAll(
    organizationId: string,
    userId: string,
    claimed: readonly ClaimedFinding[],
  ): Promise<ExecutionFailure[]> {
    const failures: ExecutionFailure[] = [];

    for (const finding of claimed) {
      if (finding.proposedAction === "none") continue;

      try {
        const undoToken = await withSavepoint(() => this.execute(organizationId, userId, finding));
        await this.db
          .update(dataQualityFindings)
          .set({ undoToken })
          .where(
            and(
              eq(dataQualityFindings.organizationId, organizationId),
              eq(dataQualityFindings.findingId, finding.findingId),
            ),
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ findingId: finding.findingId, error: message });
        this.logger.warn(`finding ${finding.findingId} could not be applied: ${message}`);
        await this.reopenFailed(organizationId, finding.findingId, message);
      }
    }

    return failures;
  }

  private async execute(
    organizationId: string,
    userId: string,
    finding: ClaimedFinding,
  ): Promise<Record<string, unknown>> {
    if (finding.proposedAction !== "merge-parties")
      throw new Error(`No executor for ${finding.proposedAction}`);

    if (!finding.relatedPartyId)
      throw new Error("A merge needs two parties and this finding names one");

    await refuseIfContradicted(this.db, organizationId, finding.partyId, finding.relatedPartyId);

    const outcome = await this.merges.merge(organizationId, {
      leftPartyId: finding.partyId,
      rightPartyId: finding.relatedPartyId,
      // A human confirmed this one, which is what separates it from the merges
      // the detector was confident enough to make on its own.
      decidedBy: "USER",
      userId,
    });

    /**
     * Captured now, not reconstructed later. `party_merges` holds both rows
     * verbatim, and this is the pointer an undo replays — deriving it afterwards
     * from the surviving record cannot tell a field the merge filled from one a
     * person edited since.
     */
    return {
      partyMergeId: outcome.partyMergeId,
      survivorPartyId: outcome.survivorPartyId,
      mergedPartyId: outcome.mergedPartyId,
    };
  }

  /**
   * Put one failed item back in the queue, carrying why.
   *
   * The other items in the decision stay resolved. That asymmetry is the point
   * of the savepoint: a bulk decision is not all-or-nothing, because insisting
   * it were would mean one unmergeable pair discarding three hundred and
   * ninety-nine successful merges.
   */
  private async reopenFailed(organizationId: string, findingId: string, message: string) {
    await this.db
      .update(dataQualityFindings)
      .set({
        status: "open",
        resolvedAt: null,
        resolvedByUserId: null,
        lastError: message.slice(0, 500),
        attemptCount: sql`${dataQualityFindings.attemptCount} + 1`,
      })
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.findingId, findingId),
        ),
      );
  }

  // ── Taking it back ────────────────────────────────────────────────────────

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
    const [resolution] = await this.db
      .select()
      .from(dataQualityResolutions)
      .where(
        and(
          eq(dataQualityResolutions.organizationId, organizationId),
          eq(dataQualityResolutions.resolutionId, resolutionId),
        ),
      )
      .limit(1);

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

    /**
     * Claim the reversal before performing it. `reversed_at IS NULL` in the
     * predicate is what makes two people clicking undo at once safe: the second
     * update matches no row and this throws, rather than both proceeding and the
     * four hundred merges being reverted twice.
     */
    const claimed = await this.db
      .update(dataQualityResolutions)
      .set({
        reversedAt: new Date(),
        reversedByUserId: userId,
        reversedReason: input.reason ?? null,
      })
      .where(
        and(
          eq(dataQualityResolutions.organizationId, organizationId),
          eq(dataQualityResolutions.resolutionId, resolutionId),
          isNull(dataQualityResolutions.reversedAt),
        ),
      )
      .returning({ resolutionId: dataQualityResolutions.resolutionId });

    if (claimed.length === 0)
      throw new ConflictException("This decision was reversed by someone else a moment ago.");

    const closed = await this.db
      .select({
        findingId: dataQualityFindings.findingId,
        undoToken: dataQualityFindings.undoToken,
      })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.resolutionId, resolutionId),
          sql`${dataQualityFindings.status} <> 'open'`,
        ),
      )
      .orderBy(asc(dataQualityFindings.findingId))
      .limit(MAX_BULK);

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

      try {
        await withSavepoint(() => this.merges.revert(organizationId, partyMergeId, userId));
        reopenable.push(finding.findingId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ findingId: finding.findingId, error: message });
        this.logger.warn(`merge ${partyMergeId} could not be reverted: ${message}`);
      }
    }

    /**
     * Only what actually came back is reopened. A finding whose merge could not
     * be undone stays closed, because reopening it would claim a record was
     * restored when it was not — and the next sweep would then file a second
     * finding for a problem that is still fixed.
     */
    const reopened = await this.reopen(organizationId, reopenable);

    await this.db
      .update(dataQualityResolutions)
      .set({ reversedCount: reopened })
      .where(
        and(
          eq(dataQualityResolutions.organizationId, organizationId),
          eq(dataQualityResolutions.resolutionId, resolutionId),
        ),
      );

    return {
      reversed: true,
      action: plan.action,
      reopened,
      failedCount: failures.length,
      failures: failures.slice(0, MAX_RECORDED_FAILURES),
    };
  }

  /**
   * One statement, again.
   *
   * `resolutionId` is deliberately left in place: a reopened finding still
   * points at the last decision taken about it, which is how "what did that
   * reversal actually cover" stays answerable afterwards.
   */
  private async reopen(organizationId: string, findingIds: string[]): Promise<number> {
    if (findingIds.length === 0) return 0;

    const rows = await this.db
      .update(dataQualityFindings)
      .set({
        status: "open",
        resolvedAt: null,
        resolvedByUserId: null,
        undoToken: null,
      })
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          inArray(dataQualityFindings.findingId, findingIds),
        ),
      )
      .returning({ findingId: dataQualityFindings.findingId });

    return rows.length;
  }
}
