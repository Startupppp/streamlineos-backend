import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { autonomyRepairPolicies, autonomySwitches } from "../../db/schema";
import { REPAIR_CLASSES } from "../../db/schema/crm/autonomy-repairs";
import { DataQualityQueueService } from "../data-quality/data-quality-queue.service";
import type { ClassOutcome, RepairDeps } from "./autonomy-repair.types";
import { resolveSwitch, switchesFor, type SwitchDecision, type SwitchRow } from "./kill-switch";
import { effectiveRepairPolicy } from "./repair-classes";
import { listRepairsPage, measureRepairLoop } from "./lib/repair-reads";
import { countUnrevertedRepairs, revertOneRepair, revertRepairBatch } from "./lib/repair-revert";
import { runRepairClass } from "./lib/repair-run";
import type {
  ListRepairsQuery,
  RunRepairsInput,
  SetRepairPolicyInput,
} from "./dto/autonomy-review.schemas";

/**
 * Fixing what can be fixed without asking, and putting it back.
 *
 * The whole value of this file is the *refusals*, and they are not evenly
 * distributed: nearly every finding in the queue reaches here and leaves
 * untouched. A repair happens only where `repair-classes.ts` says the class is
 * one the system repairs at all, this tenant has not withheld it, and the value
 * itself admits exactly one fix. Anything else routes to the human queue, which
 * is where it already was.
 *
 * Nothing here calls a model. That is not a shortcut — a class earns its place in
 * the enumeration by being computable, and a judgement about what a value
 * "probably" meant is precisely the thing that must reach a person instead.
 *
 * The ledger is `autonomous_decisions`, the same table as every other autonomous
 * write, so the review feed, the kill switch, the scoreboard and the one-click
 * reversal all reach repairs with no second mechanism anybody has to know about.
 *
 * This class is the grant surface and the entry point to each half: one class's
 * pass lives in `lib/repair-run.ts`, the undo in `lib/repair-revert.ts`, and the
 * reads in `lib/repair-reads.ts`.
 */
@Injectable()
export class AutonomyRepairService {
  private readonly logger = new Logger("AutonomyRepair");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queue: DataQualityQueueService,
  ) {}

  /** The request transaction, the queue and this class's logger, as the libs take them. */
  private get deps(): RepairDeps {
    return { db: this.db, queue: this.queue, logger: this.logger };
  }

  // ── What this tenant allows ───────────────────────────────────────────────

  /**
   * Every class, with this organisation's answer against it.
   *
   * The whole enumeration every time, defaults included, because this is the
   * screen where autonomy is granted — a list showing only what had been
   * configured would hide exactly the classes nobody has thought about yet.
   */
  async policiesFor(organizationId: string) {
    const [rows, switchDecision] = await Promise.all([
      this.storedPolicies(organizationId),
      this.repairSwitch(organizationId),
    ]);

    return {
      /**
       * Reported beside the per-class answers rather than folded into them.
       *
       * A tenant looking at a screen of enabled classes while nothing is being
       * repaired needs to be told the wider veto is what stopped it — folding
       * the switch into each row would render every class as "off" and make the
       * setting they just changed look broken.
       */
      autonomy: switchDecision,
      classes: effectiveRepairPolicy(rows).map((entry) => ({
        ...entry,
        effective: entry.enabled && switchDecision.allowed,
      })),
    };
  }

  /**
   * Turn one class on, or off, for this organisation.
   *
   * Takes effect on the next run because every path here re-reads the table
   * rather than caching it — the same reasoning the kill switch is uncached for.
   * A grant behind a cache is a grant with a delay nobody can predict, and its
   * revocation is worse.
   */
  async setPolicy(organizationId: string, userId: string, input: SetRepairPolicyInput) {
    await this.db
      .insert(autonomyRepairPolicies)
      .values({
        organizationId,
        repairClass: input.repairClass,
        enabled: input.enabled,
        reason: input.reason ?? null,
        updatedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [autonomyRepairPolicies.organizationId, autonomyRepairPolicies.repairClass],
        set: {
          enabled: input.enabled,
          reason: input.reason ?? null,
          updatedByUserId: userId,
          updatedAt: new Date(),
        },
      });

    return this.policiesFor(organizationId);
  }

  private async storedPolicies(organizationId: string) {
    return this.db
      .select({
        repairClass: autonomyRepairPolicies.repairClass,
        enabled: autonomyRepairPolicies.enabled,
        reason: autonomyRepairPolicies.reason,
      })
      .from(autonomyRepairPolicies)
      .where(eq(autonomyRepairPolicies.organizationId, organizationId));
  }

  /**
   * The kill switch as it applies to repairs.
   *
   * Read here rather than taken from `AutonomyReviewService` so the dependency
   * runs one way: the review service reaches this one to perform a batch
   * reversal, and a second edge back would be a cycle for the sake of a query
   * that is four lines long.
   */
  private async repairSwitch(organizationId: string): Promise<SwitchDecision> {
    const rows = await this.db
      .select({
        organizationId: autonomySwitches.organizationId,
        kind: autonomySwitches.kind,
        enabled: autonomySwitches.enabled,
        reason: autonomySwitches.reason,
      })
      .from(autonomySwitches)
      .where(
        sql`${autonomySwitches.organizationId} IS NULL OR ${autonomySwitches.organizationId} = ${organizationId}`,
      );

    return resolveSwitch(
      organizationId,
      "field.repaired",
      switchesFor(organizationId, rows as SwitchRow[]),
    );
  }

  // ── Running the loop ──────────────────────────────────────────────────────

  /**
   * Repair what may be repaired, one decision per class.
   *
   * Class by class rather than finding by finding, because the unit of review is
   * the class: "412 numbers rewritten from fullwidth digits" is one thing a
   * manager reads and can undo, and 412 entries is a feed nobody opens twice.
   */
  async runRepairs(organizationId: string, input: RunRepairsInput) {
    const requested = input.classes ?? REPAIR_CLASSES;
    const [policies, switchDecision] = await Promise.all([
      this.storedPolicies(organizationId),
      this.repairSwitch(organizationId),
    ]);

    const outcomes: ClassOutcome[] = [];
    for (const repairClass of REPAIR_CLASSES) {
      if (!requested.includes(repairClass)) continue;
      outcomes.push(
        await runRepairClass(this.deps, organizationId, repairClass, input.limit, {
          autonomySwitch: switchDecision,
          policies,
        }),
      );
    }

    return {
      classes: outcomes,
      repaired: outcomes.reduce((total, row) => total + row.repaired, 0),
      /** What was seen and deliberately left for a person. The loop's other half. */
      leftForAPerson: outcomes.reduce((total, row) => total + row.refused, 0),
    };
  }

  // ── Taking it back ────────────────────────────────────────────────────────

  /**
   * Put one value back.
   *
   * The individual half of "reversible individually and as a batch". A manager
   * who agrees with three hundred and ninety-nine repairs and not the four
   * hundredth must not have to undo all four hundred to say so.
   */
  async revertOne(
    organizationId: string,
    userId: string,
    repairId: string,
    reason: string | null,
  ) {
    return revertOneRepair(this.deps, organizationId, userId, repairId, reason);
  }

  /**
   * Put a whole decision's worth of values back.
   *
   * Called from `AutonomyReviewService` when a reviewer reverses the decision in
   * the feed, so a repair batch is undone by the same one click as every other
   * autonomous action. Values a person has changed since are skipped rather than
   * overwritten, and the count says how many — a reversal that silently ignored
   * them would claim to have restored records it did not touch.
   */
  async revertBatch(
    organizationId: string,
    userId: string,
    autonomousDecisionId: string,
    reason: string | null,
  ): Promise<{ reverted: number; skipped: number }> {
    return revertRepairBatch(this.deps, organizationId, userId, autonomousDecisionId, reason);
  }

  /** How many values from this decision are still standing, for the planner. */
  async countUnreverted(
    organizationId: string,
    autonomousDecisionId: string,
  ): Promise<number> {
    return countUnrevertedRepairs(this.db, organizationId, autonomousDecisionId);
  }

  // ── Reading what happened ─────────────────────────────────────────────────

  async listRepairs(organizationId: string, query: ListRepairsQuery) {
    return listRepairsPage(this.db, organizationId, query);
  }

  /**
   * The loop's measure: how much of the queue the system cleared, against how
   * much a person did, and what is left.
   *
   * The ratio alone would be gameable and, worse, misleading — a loop that
   * repaired every trivial finding and left every hard one would show a rising
   * share while the queue got harder. So the composition of what remains sits
   * beside it, and that is the number that says whether the humans are being
   * left the work only humans can do or simply being left the work.
   */
  async measure(organizationId: string, days: number) {
    return measureRepairLoop(this.deps, organizationId, days);
  }
}
