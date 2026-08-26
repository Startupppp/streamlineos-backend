import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyRepairPolicies,
  autonomyRepairs,
  autonomySwitches,
  businessParties,
} from "../../db/schema";
import type { RepairClass } from "../../db/schema/crm/autonomy-repairs";
import { REPAIR_CLASSES } from "../../db/schema/crm/autonomy-repairs";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBefore } from "../../common/pagination/keyset";
import { updatePartyWithMirror } from "../party/party-legacy-writer";
import { DataQualityQueueService } from "../data-quality/data-quality-queue.service";
import { buildDecision } from "./decision-record";
import { resolveSwitch, switchesFor, type SwitchDecision, type SwitchRow } from "./kill-switch";
import {
  REPAIR_CLASS_DEFINITIONS,
  effectiveRepairPolicy,
  mayRepair,
  proposeRepair,
  type RepairPermission,
} from "./repair-classes";
import type {
  ListRepairsQuery,
  RunRepairsInput,
  SetRepairPolicyInput,
} from "./dto/autonomy-review.schemas";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The patch, written as a branch rather than a computed key.
 *
 * `{ [field]: value }` widens to an index signature, which `PartyPatch` does not
 * accept — and rightly so: the mirror derives a legacy row from every column it
 * is handed, so a patch whose keys the compiler cannot see is a patch whose
 * mirror nobody can check.
 */
function fieldPatch(field: "email" | "phone", value: string | null) {
  return field === "email" ? { email: value } : { phone: value };
}

/** What one class's pass concluded, whether or not it changed anything. */
interface ClassOutcome {
  readonly repairClass: RepairClass;
  readonly considered: number;
  readonly repaired: number;
  readonly refused: number;
  readonly failed: number;
  readonly autonomousDecisionId: string | null;
  readonly outcome: "applied" | "skipped";
  readonly explanation: string | null;
}

interface RepairDraft {
  readonly findingId: string;
  readonly partyId: string;
  readonly field: "email" | "phone";
  readonly previousValue: string;
  readonly repairedValue: string;
}

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
 */
@Injectable()
export class AutonomyRepairService {
  private readonly logger = new Logger("AutonomyRepair");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queue: DataQualityQueueService,
  ) {}

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
        await this.runOneClass(organizationId, repairClass, input.limit, {
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

  private async runOneClass(
    organizationId: string,
    repairClass: RepairClass,
    limit: number,
    context: { autonomySwitch: SwitchDecision; policies: { repairClass: string; enabled: boolean }[] },
  ): Promise<ClassOutcome> {
    const definition = REPAIR_CLASS_DEFINITIONS[repairClass];
    const candidates = await this.queue.repairCandidates(
      organizationId,
      [definition.findingKind],
      limit,
    );

    /**
     * Nothing to decide about, so nothing is recorded.
     *
     * The refusal below is a decision because something was actually left
     * undone. A row saying "considered zero findings and did nothing" would be
     * noise proportional to how often the loop runs rather than to what it
     * found, and it would bury the refusals that matter.
     */
    if (candidates.length === 0)
      return {
        repairClass,
        considered: 0,
        repaired: 0,
        refused: 0,
        failed: 0,
        autonomousDecisionId: null,
        outcome: "skipped",
        explanation: null,
      };

    const permission = mayRepair(repairClass, context);
    if (!permission.allowed)
      return this.recordRefusal(organizationId, repairClass, candidates.length, permission);

    const drafts: RepairDraft[] = [];
    let refused = 0;

    for (const candidate of candidates) {
      const current = await this.currentValue(organizationId, candidate.partyId, definition.field);
      if (current === null) {
        refused += 1;
        continue;
      }

      /**
       * Proposed from what is on the record now, never from the finding's
       * evidence.
       *
       * The evidence records what a sweep saw, possibly weeks ago. Repairing
       * from it would overwrite a value somebody has corrected since with a
       * "fix" for a problem that no longer exists — the same hazard
       * `planReversal` refuses a changed deal for.
       */
      const proposal = proposeRepair(repairClass, current);
      if (!proposal.ok) {
        refused += 1;
        continue;
      }

      drafts.push({
        findingId: candidate.findingId,
        partyId: candidate.partyId,
        field: definition.field,
        previousValue: current,
        repairedValue: proposal.next,
      });
    }

    if (drafts.length === 0)
      return {
        repairClass,
        considered: candidates.length,
        repaired: 0,
        refused,
        failed: 0,
        autonomousDecisionId: null,
        outcome: "skipped",
        explanation: "Nothing in this class had a single unambiguous repair.",
      };

    return this.applyBatch(organizationId, repairClass, candidates.length, refused, drafts);
  }

  /**
   * The refusal, written down.
   *
   * A class this tenant has not granted is not a no-op: findings were seen,
   * counted, and deliberately left in the human queue. Recording that as a
   * `skipped` decision is what makes "why did nothing happen" answerable from
   * the same feed as "why did this happen" — the alternative is a silence,
   * which reads identically to the loop never having run.
   */
  private async recordRefusal(
    organizationId: string,
    repairClass: RepairClass,
    considered: number,
    permission: Extract<RepairPermission, { allowed: false }>,
  ): Promise<ClassOutcome> {
    const [row] = await this.db
      .insert(autonomousDecisions)
      .values(
        buildDecision({
          organizationId,
          kind: "field.repaired",
          outcome: "skipped",
          triggerType: "repair.sweep",
          triggerId: repairClass,
          summary: `Left ${considered} ${repairClass} finding(s) for a person: ${permission.explanation}`,
          decision: {
            repairClass,
            refused: considered,
            reason: permission.reason,
            decidedBy: permission.decidedBy,
          },
        }),
      )
      .returning({ id: autonomousDecisions.autonomousDecisionId });

    return {
      repairClass,
      considered,
      repaired: 0,
      refused: considered,
      autonomousDecisionId: row?.id ?? null,
      failed: 0,
      outcome: "skipped",
      explanation: permission.explanation,
    };
  }

  /**
   * One decision, one row per value, and the findings closed against it.
   *
   * The decision is written first because every repair row carries a foreign key
   * to it — the same ordering `DataQualityResolutionService` uses, and for the
   * same reason.
   */
  private async applyBatch(
    organizationId: string,
    repairClass: RepairClass,
    considered: number,
    refusedSoFar: number,
    drafts: readonly RepairDraft[],
  ): Promise<ClassOutcome> {
    const definition = REPAIR_CLASS_DEFINITIONS[repairClass];

    const [decision] = await this.db
      .insert(autonomousDecisions)
      .values(
        buildDecision({
          organizationId,
          kind: "field.repaired",
          outcome: "applied",
          triggerType: "repair.sweep",
          triggerId: repairClass,
          summary: `Repaired ${drafts.length} ${definition.field} value(s): ${repairClass}`,
          decision: {
            repairClass,
            field: definition.field,
            considered,
            repaired: drafts.length,
          },
          /**
           * A sample, not the batch. The values live one per row in
           * `autonomy_repairs`; this is the handful a reviewer sees without
           * opening anything, and copying four hundred of them here would make
           * the ledger larger than the records it describes.
           */
          inputs: {
            examples: drafts.slice(0, 5).map((draft) => ({
              from: draft.previousValue,
              to: draft.repairedValue,
            })),
          },
        }),
      )
      .returning({ id: autonomousDecisions.autonomousDecisionId });

    if (!decision) throw new ConflictException("The repair could not be recorded");

    const applied: RepairDraft[] = [];
    const failures: string[] = [];

    for (const draft of drafts) {
      try {
        /**
         * Through the mirror writer rather than a direct column update.
         *
         * Party is canonical and `leads`/`contacts` mirror it, so a repair
         * written only to `business_parties` would be invisible on every legacy
         * screen — the record would still show the malformed value and the next
         * divergence check would report the party as the one that is wrong.
         * `updatePartyWithMirror` opens its own savepoint, so one party failing
         * costs that party.
         */
        await updatePartyWithMirror(
          this.db,
          organizationId,
          draft.partyId,
          fieldPatch(draft.field, draft.repairedValue),
        );
        applied.push(draft);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(draft.findingId);
        this.logger.warn(`repair of party ${draft.partyId} failed: ${message}`);
      }
    }

    if (applied.length > 0)
      await this.db.insert(autonomyRepairs).values(
        applied.map((draft) => ({
          organizationId,
          autonomousDecisionId: decision.id,
          repairClass,
          findingId: draft.findingId,
          partyId: draft.partyId,
          field: draft.field,
          previousValue: draft.previousValue,
          repairedValue: draft.repairedValue,
        })),
      );

    const closed = await this.queue.closeAsRepaired(
      organizationId,
      decision.id,
      applied.map((draft) => draft.findingId),
    );

    /**
     * The counts are corrected on the decision after the fact rather than
     * predicted before it, so a partly-applied batch never reads as complete.
     */
    if (applied.length !== drafts.length)
      await this.db
        .update(autonomousDecisions)
        .set({
          summary: `Repaired ${applied.length} of ${drafts.length} ${definition.field} value(s): ${repairClass}`,
          decision: {
            repairClass,
            field: definition.field,
            considered,
            repaired: applied.length,
            failed: drafts.length - applied.length,
          },
        })
        .where(
          and(
            eq(autonomousDecisions.organizationId, organizationId),
            eq(autonomousDecisions.autonomousDecisionId, decision.id),
          ),
        );

    return {
      repairClass,
      considered,
      repaired: closed.length,
      refused: refusedSoFar,
      failed: failures.length,
      autonomousDecisionId: decision.id,
      outcome: "applied",
      explanation: null,
    };
  }

  private async currentValue(
    organizationId: string,
    partyId: string,
    field: "email" | "phone",
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ email: businessParties.email, phone: businessParties.phone })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(1);

    const value = field === "email" ? row?.email : row?.phone;
    return value && value.trim().length > 0 ? value : null;
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
    const [repair] = await this.db
      .select()
      .from(autonomyRepairs)
      .where(
        and(
          eq(autonomyRepairs.organizationId, organizationId),
          eq(autonomyRepairs.autonomyRepairId, repairId),
        ),
      )
      .limit(1);

    // Another organisation's identifier reads as absent; a 403 would confirm it.
    if (!repair) throw new NotFoundException("Repair not found");
    if (repair.revertedAt) throw new ConflictException("This repair was already taken back.");

    const reverted = await this.restore(organizationId, userId, repair, reason);
    if (!reverted)
      throw new ConflictException(
        "That value has changed since the repair, so putting it back would undo somebody else's edit rather than the system's.",
      );

    await this.queue.reopenAfterRepairReverted(
      organizationId,
      repair.findingId ? [repair.findingId] : [],
    );

    return { reverted: true, partyId: repair.partyId, field: repair.field };
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
    const repairs = await this.db
      .select()
      .from(autonomyRepairs)
      .where(
        and(
          eq(autonomyRepairs.organizationId, organizationId),
          eq(autonomyRepairs.autonomousDecisionId, autonomousDecisionId),
          isNull(autonomyRepairs.revertedAt),
        ),
      )
      .orderBy(desc(autonomyRepairs.appliedAt))
      .limit(1000);

    const restored: string[] = [];
    let skipped = 0;

    for (const repair of repairs) {
      const ok = await this.restore(organizationId, userId, repair, reason);
      if (ok && repair.findingId) restored.push(repair.findingId);
      if (!ok) skipped += 1;
    }

    await this.queue.reopenAfterRepairReverted(organizationId, restored);

    return { reverted: repairs.length - skipped, skipped };
  }

  /**
   * One value, put back, if it is still the value the system wrote.
   *
   * `repaired_value` in the predicate is what makes the undo safe: somebody who
   * has edited the field since owns it now, and restoring over them would be a
   * reversal of their judgement rather than the system's.
   */
  private async restore(
    organizationId: string,
    userId: string,
    repair: typeof autonomyRepairs.$inferSelect,
    reason: string | null,
  ): Promise<boolean> {
    const claimed = await this.db
      .update(autonomyRepairs)
      .set({ revertedAt: new Date(), revertedByUserId: userId, revertedReason: reason })
      .where(
        and(
          eq(autonomyRepairs.organizationId, organizationId),
          eq(autonomyRepairs.autonomyRepairId, repair.autonomyRepairId),
          isNull(autonomyRepairs.revertedAt),
        ),
      )
      .returning({ id: autonomyRepairs.autonomyRepairId });

    // Somebody else took this one back a moment ago; theirs stands.
    if (claimed.length === 0) return false;

    const current = await this.currentValue(
      organizationId,
      repair.partyId,
      repair.field === "email" ? "email" : "phone",
    );

    if (current !== repair.repairedValue) {
      await this.db
        .update(autonomyRepairs)
        .set({ revertedAt: null, revertedByUserId: null, revertedReason: null })
        .where(
          and(
            eq(autonomyRepairs.organizationId, organizationId),
            eq(autonomyRepairs.autonomyRepairId, repair.autonomyRepairId),
          ),
        );
      return false;
    }

    await updatePartyWithMirror(
      this.db,
      organizationId,
      repair.partyId,
      fieldPatch(repair.field === "email" ? "email" : "phone", repair.previousValue),
    );

    return true;
  }

  /** How many values from this decision are still standing, for the planner. */
  async countUnreverted(
    organizationId: string,
    autonomousDecisionId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(autonomyRepairs)
      .where(
        and(
          eq(autonomyRepairs.organizationId, organizationId),
          eq(autonomyRepairs.autonomousDecisionId, autonomousDecisionId),
          isNull(autonomyRepairs.revertedAt),
        ),
      );

    return Number(row?.n ?? 0);
  }

  // ── Reading what happened ─────────────────────────────────────────────────

  async listRepairs(organizationId: string, query: ListRepairsQuery) {
    const position = decodeCursor(query.cursor);
    const conditions = and(
      eq(autonomyRepairs.organizationId, organizationId),
      query.repairClass ? eq(autonomyRepairs.repairClass, query.repairClass) : undefined,
      query.revertedOnly ? isNotNull(autonomyRepairs.revertedAt) : undefined,
    );

    const keyset = position
      ? and(
          conditions,
          keysetBefore(autonomyRepairs.appliedAt, autonomyRepairs.autonomyRepairId, position),
        )
      : conditions;

    const rows = await this.db
      .select({
        autonomyRepairId: autonomyRepairs.autonomyRepairId,
        autonomousDecisionId: autonomyRepairs.autonomousDecisionId,
        repairClass: autonomyRepairs.repairClass,
        findingId: autonomyRepairs.findingId,
        partyId: autonomyRepairs.partyId,
        field: autonomyRepairs.field,
        previousValue: autonomyRepairs.previousValue,
        repairedValue: autonomyRepairs.repairedValue,
        appliedAt: autonomyRepairs.appliedAt,
        revertedAt: autonomyRepairs.revertedAt,
        revertedByUserId: autonomyRepairs.revertedByUserId,
        revertedReason: autonomyRepairs.revertedReason,
        partyName: businessParties.name,
      })
      .from(autonomyRepairs)
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, autonomyRepairs.organizationId),
          eq(businessParties.partyId, autonomyRepairs.partyId),
        ),
      )
      .where(keyset)
      .orderBy(desc(autonomyRepairs.appliedAt), desc(autonomyRepairs.autonomyRepairId))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.appliedAt.toISOString(),
      id: row.autonomyRepairId,
    }));
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
    const since = new Date(Date.now() - days * DAY_MS);

    const [mix, health, byClass] = await Promise.all([
      this.queue.resolutionMix(organizationId, since),
      this.queue.health(organizationId, { days }),
      this.db
        .select({
          repairClass: autonomyRepairs.repairClass,
          applied: count(),
          reverted: sql<number>`count(*) FILTER (WHERE ${autonomyRepairs.revertedAt} IS NOT NULL)`,
        })
        .from(autonomyRepairs)
        .where(
          and(
            eq(autonomyRepairs.organizationId, organizationId),
            gte(autonomyRepairs.appliedAt, since),
          ),
        )
        .groupBy(autonomyRepairs.repairClass),
    ]);

    const decided = mix.automated + mix.manual;

    return {
      windowDays: days,
      resolution: {
        ...mix,
        /**
         * Null rather than zero when nothing was decided. A ratio over an empty
         * window is not "no automation"; it is no evidence, and the two look the
         * same on a chart only if one of them lies.
         */
        automatedShare: decided > 0 ? mix.automated / decided : null,
      },
      repairs: {
        byClass: byClass.map((row) => ({
          repairClass: row.repairClass,
          applied: Number(row.applied),
          reverted: Number(row.reverted),
        })),
        applied: byClass.reduce((total, row) => total + Number(row.applied), 0),
        reverted: byClass.reduce((total, row) => total + Number(row.reverted), 0),
      },
      /** What the system did not take, in the shape it was left in. */
      remaining: {
        total: health.open.total,
        weighted: health.open.weighted,
        byProducer: health.open.byProducer,
        oldestOpenAgeDays: health.oldestOpenAgeDays,
      },
    };
  }
}
