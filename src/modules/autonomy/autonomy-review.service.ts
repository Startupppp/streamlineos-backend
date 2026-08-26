import {
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { keysetBefore } from "../../common/pagination/keyset";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  autonomousDecisions,
  autonomyCorrections,
  autonomySwitches,
  businessParties,
  deals,
} from "../../db/schema";
import { DECISION_KINDS, type DecisionKind } from "../../db/schema/crm/autonomous-decisions";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { DealsService } from "../deals/deals.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import { planReversal, type TargetState } from "./reversal-plan";
import { resolveSwitch, switchesFor, type SwitchRow } from "./kill-switch";
import { ROUTINE_KINDS, type ListDecisionsQuery, type ReverseDecisionInput, type SetSwitchInput } from "./dto/autonomy-review.schemas";
import { softDeletePartyWithMirror } from "../party/party-legacy-writer";

/**
 * Reading and undoing what the system did on its own.
 *
 * Because nothing asks for approval, this is the entire oversight mechanism. It
 * has to be readable rather than complete-looking, and the undo has to be safe
 * enough that a manager can use it without reading the code first.
 */
@Injectable()
export class AutonomyReviewService {
  private readonly logger = new Logger("AutonomyReview");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dealsService: DealsService,
    /**
     * Circular by nature: the hold service reads settings this module owns, and
     * the kill switch here has to reach into holds already in flight.
     */
    @Optional()
    @Inject(forwardRef(() => AutonomyHoldService))
    private readonly holds?: AutonomyHoldService,
  ) {}

  // ── The feed ──────────────────────────────────────────────────────────────

  async listDecisions(
    organizationId: string,
    userId: string,
    query: ListDecisionsQuery,
    scope: DataScope,
  ) {
    const { limit, cursor, kind, outcome, partyId, dealId, assignedToId, reversedOnly, includeRoutine } = query;
    const position = decodeCursor(cursor);

    const filters: (SQL | undefined)[] = [
      eq(autonomousDecisions.organizationId, organizationId),
      kind ? eq(autonomousDecisions.kind, kind) : undefined,
      outcome ? eq(autonomousDecisions.outcome, outcome) : undefined,
      partyId ? eq(autonomousDecisions.partyId, partyId) : undefined,
      dealId ? eq(autonomousDecisions.dealId, dealId) : undefined,
      reversedOnly ? isNotNull(autonomousDecisions.reversedAt) : undefined,
      assignedToId ? eq(deals.assignedToId, assignedToId) : undefined,
      // An explicit `kind` filter wins: asking for routine entries by name should
      // show them without also having to set the toggle.
      !includeRoutine && !kind
        ? notInArray(autonomousDecisions.kind, [...ROUTINE_KINDS])
        : undefined,
      this.scopePredicate(scope, organizationId, userId),
    ];

    const conditions = and(...filters.filter((c): c is SQL => c !== undefined));

    const keyset = position
      ? and(
          conditions,
          // Row-value comparison matching idx_autonomous_decisions_feed's order,
          // so the scan starts at the cursor rather than reading and discarding.
          keysetBefore(autonomousDecisions.decidedAt, autonomousDecisions.autonomousDecisionId, position),
        )
      : conditions;

    const rows = await this.db
      .select({
        autonomousDecisionId: autonomousDecisions.autonomousDecisionId,
        kind: autonomousDecisions.kind,
        outcome: autonomousDecisions.outcome,
        summary: autonomousDecisions.summary,
        confidence: autonomousDecisions.confidence,
        reversibility: autonomousDecisions.reversibility,
        triggerType: autonomousDecisions.triggerType,
        triggerId: autonomousDecisions.triggerId,
        partyId: autonomousDecisions.partyId,
        dealId: autonomousDecisions.dealId,
        activityId: autonomousDecisions.activityId,
        decidedAt: autonomousDecisions.decidedAt,
        reversedAt: autonomousDecisions.reversedAt,
        reversedByUserId: autonomousDecisions.reversedByUserId,
        reversedReason: autonomousDecisions.reversedReason,
        /**
         * The operator's columns. Present on every row so a reviewer who needs
         * to trace a regression has them, and rendered behind a disclosure so
         * they do not clutter the default view.
         */
        model: autonomousDecisions.model,
        promptVersion: autonomousDecisions.promptVersion,
        /** Named so the reader can open the record rather than an identifier. */
        dealName: deals.name,
        partyName: businessParties.name,
      })
      .from(autonomousDecisions)
      .leftJoin(
        deals,
        and(
          eq(deals.orgId, autonomousDecisions.organizationId),
          sql`${deals.id}::text = ${autonomousDecisions.dealId}`,
        ),
      )
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, autonomousDecisions.organizationId),
          eq(businessParties.partyId, autonomousDecisions.partyId),
        ),
      )
      .where(keyset)
      .orderBy(desc(autonomousDecisions.decidedAt), desc(autonomousDecisions.autonomousDecisionId))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.decidedAt.toISOString(),
      id: row.autonomousDecisionId,
    }));
  }

  /**
   * What a narrowed reader may see.
   *
   * Decisions hang off deals, so `own` and `team` resolve through the deal's
   * assignee — the same column the deals list narrows on, so the two agree.
   *
   * A decision with no deal (a party created from an unknown sender, say) is
   * nobody's record in particular, and the left join makes the comparison NULL,
   * which excludes it. That is deliberate: a narrowed reader seeing every
   * unattributed action would be a wider view than their deals list gives them.
   */
  private scopePredicate(scope: DataScope, organizationId: string, userId: string): SQL | undefined {
    if (scope === "all") return undefined;
    return applyScope(scope, organizationId, userId, { ownerColumn: deals.assignedToId });
  }

  async getDecision(organizationId: string, decisionId: string) {
    const [row] = await this.db
      .select()
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
        ),
      )
      .limit(1);

    // Another organisation's identifier is indistinguishable from one that does
    // not exist, which is the point: a 403 here would confirm it exists.
    if (!row) throw new NotFoundException("Decision not found");

    const corrections = await this.db
      .select()
      .from(autonomyCorrections)
      .where(
        and(
          eq(autonomyCorrections.organizationId, organizationId),
          eq(autonomyCorrections.autonomousDecisionId, decisionId),
        ),
      )
      .orderBy(desc(autonomyCorrections.createdAt))
      .limit(20);

    return { ...row, corrections };
  }

  // ── Undoing one ───────────────────────────────────────────────────────────

  /**
   * Take back one autonomous action.
   *
   * Everything here rides the request's own transaction rather than opening a
   * nested one. `createTenantAwareDb` resolves `this.db` to the ambient tenant
   * transaction, so a `this.db.transaction(...)` here would open a SAVEPOINT
   * for these writes while `DealsService` — which reads the same ambient
   * context — kept writing to the outer transaction. Rolling the savepoint back
   * would then undo the ledger row and leave the stage change committed. One
   * transaction, and a throw rolls the whole request back.
   */
  async reverseDecision(
    organizationId: string,
    userId: string,
    decisionId: string,
    input: ReverseDecisionInput,
  ) {
    const [decision] = await this.db
      .select()
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
        ),
      )
      .limit(1);

    if (!decision) throw new NotFoundException("Decision not found");

    const target = await this.loadTarget(organizationId, decision.kind, decision);
    const plan = planReversal(
      {
        kind: decision.kind,
        outcome: decision.outcome,
        reversibility: decision.reversibility,
        reversedAt: decision.reversedAt,
        dealId: decision.dealId,
        activityId: decision.activityId,
        partyId: decision.partyId,
        decision: decision.decision,
      },
      target,
    );

    if (!plan.ok) throw new ConflictException(plan.explanation);

    /**
     * Claim the reversal before performing it.
     *
     * `reversed_at IS NULL` in the predicate is what makes two managers clicking
     * at once safe: the second update matches no row and this throws, rather
     * than both proceeding and the effect being applied twice.
     */
    const claimed = await this.db
      .update(autonomousDecisions)
      .set({
        reversedAt: new Date(),
        reversedByUserId: userId,
        reversedReason: input.reason ?? null,
        outcome: "reversed",
      })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
          isNull(autonomousDecisions.reversedAt),
        ),
      )
      .returning({ id: autonomousDecisions.autonomousDecisionId });

    if (claimed.length === 0)
      throw new ConflictException("This was reversed by someone else a moment ago.");

    const { field, systemValue, humanValue } = await this.applyReversal(
      organizationId,
      userId,
      plan,
    );

    /**
     * The correction, captured at the moment it is made.
     *
     * This is the only point at which both answers are known: the system's, and
     * the human's implicit "not that". Reconstructing it later from the record's
     * history is guesswork.
     */
    await this.db.insert(autonomyCorrections).values({
      organizationId,
      autonomousDecisionId: decisionId,
      kind: decision.kind,
      correctionType: "reversal",
      field,
      systemValue,
      humanValue,
      reason: input.reason ?? null,
      correctedByUserId: userId,
      consented: input.consented,
    });

    return { reversed: true, action: plan.action };
  }

  private async applyReversal(
    organizationId: string,
    userId: string,
    plan: Extract<ReturnType<typeof planReversal>, { ok: true }>,
  ): Promise<{ field: string; systemValue: string | null; humanValue: string | null }> {
    switch (plan.action) {
      case "restore-stage": {
        /**
         * Through the deals service, not a direct update, so the stage ledger
         * records the reversal as its own transition with a human actor. A
         * reversal that left no trace in the deal's own history would be an
         * oversight mechanism with a blind spot.
         */
        const moved = await this.dealsService.updateDeal(
          organizationId,
          userId,
          Number(plan.dealId),
          { stage: plan.toStage, stageChangeReason: "Reversed an autonomous stage change" },
          { kind: "human", userId },
        );

        if (!moved.ok)
          throw new ConflictException("The deal could not be moved back — it may have changed.");

        return { field: "stage", systemValue: plan.fromStage, humanValue: plan.toStage };
      }

      case "delete-activity": {
        await this.db
          .update(activities)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(activities.organizationId, organizationId),
              eq(activities.activityId, plan.activityId),
              isNull(activities.deletedAt),
            ),
          );

        return { field: "task", systemValue: "created", humanValue: "removed" };
      }

      case "delete-party": {
        // The party is canonical and every legacy row mapped to it is a mirror,
        // so reversing an autonomous creation has to take both down together --
        // otherwise the record the system created is still visible on every
        // screen that reads `leads` or `contacts`.
        const [live] = await this.db
          .select({ partyId: businessParties.partyId })
          .from(businessParties)
          .where(
            and(
              eq(businessParties.organizationId, organizationId),
              eq(businessParties.partyId, plan.partyId),
              isNull(businessParties.deletedAt),
            ),
          )
          .limit(1);
        if (live) await softDeletePartyWithMirror(this.db, organizationId, live.partyId);

        return { field: "party", systemValue: "created", humanValue: "removed" };
      }
    }
  }

  /** The current state of whatever the decision touched, for the planner. */
  private async loadTarget(
    organizationId: string,
    kind: DecisionKind,
    decision: { dealId: string | null; activityId: string | null; partyId: string | null },
  ): Promise<TargetState> {
    if (kind === "stage.advanced") {
      const numeric = Number(decision.dealId);
      if (!decision.dealId || !Number.isInteger(numeric)) return null;

      const [row] = await this.db
        .select({ stage: deals.stage })
        .from(deals)
        .where(and(eq(deals.orgId, organizationId), eq(deals.id, numeric), isNull(deals.deletedAt)))
        .limit(1);

      return row ? { kind: "deal", stage: row.stage } : null;
    }

    if (kind === "task.extracted" || kind === "activity.logged") {
      if (!decision.activityId) return null;

      const [row] = await this.db
        .select({ deletedAt: activities.deletedAt, completedAt: activities.completedAt })
        .from(activities)
        .where(
          and(
            eq(activities.organizationId, organizationId),
            eq(activities.activityId, decision.activityId),
          ),
        )
        .limit(1);

      return row ? { kind: "activity", deletedAt: row.deletedAt, completedAt: row.completedAt } : null;
    }

    if (kind === "party.created") {
      if (!decision.partyId) return null;

      const [row] = await this.db
        .select({ deletedAt: businessParties.deletedAt })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, organizationId),
            eq(businessParties.partyId, decision.partyId),
          ),
        )
        .limit(1);

      return row ? { kind: "party", deletedAt: row.deletedAt } : null;
    }

    return null;
  }

  // ── The kill switch ───────────────────────────────────────────────────────

  /**
   * Every switch that governs this organisation, platform rows included.
   *
   * A tenant needs to see the platform veto, or "why has automation stopped"
   * has no answer they can reach.
   */
  async listSwitches(organizationId: string) {
    const rows = await this.db
      .select({
        organizationId: autonomySwitches.organizationId,
        kind: autonomySwitches.kind,
        enabled: autonomySwitches.enabled,
        reason: autonomySwitches.reason,
        updatedAt: autonomySwitches.updatedAt,
      })
      .from(autonomySwitches)
      .where(
        sql`${autonomySwitches.organizationId} IS NULL OR ${autonomySwitches.organizationId} = ${organizationId}`,
      );

    const scoped = switchesFor(organizationId, rows as SwitchRow[]);

    return {
      switches: rows,
      /** The resolved answer per action type — what actually governs behaviour. */
      effective: DECISION_KINDS.map(
        (kind) => ({ kind, ...resolveSwitch(organizationId, kind, scoped) }),
      ),
    };
  }

  /**
   * Turn one action type off, or back on, for this organisation.
   *
   * Takes effect on the next decision because the resolver reads this table
   * every time rather than caching it — a kill switch behind a cache is a kill
   * switch with a delay nobody can predict.
   */
  async setSwitch(organizationId: string, userId: string, input: SetSwitchInput) {
    await this.db
      .insert(autonomySwitches)
      .values({
        organizationId,
        kind: input.kind,
        enabled: input.enabled,
        reason: input.reason ?? null,
        updatedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [autonomySwitches.organizationId, autonomySwitches.kind],
        set: {
          enabled: input.enabled,
          reason: input.reason ?? null,
          updatedByUserId: userId,
          updatedAt: new Date(),
        },
      });

    /**
     * Turning something off also stops what it already decided to do.
     *
     * Blocking new holds alone would leave the more dangerous half running: the
     * messages the system has already committed to and is merely waiting to
     * send. An operator killing quote sending at noon must not watch a hold
     * placed at nine leave at one.
     */
    if (!input.enabled && this.holds) {
      const cancelled = await this.holds.cancelInFlight(organizationId, userId, input.kind);
      if (cancelled > 0)
        this.logger.warn(
          `kill switch on ${input.kind} cancelled ${cancelled} hold(s) already in flight`,
        );
    }

    return this.listSwitches(organizationId);
  }

  // ── Corrections made outside the feed ─────────────────────────────────────

  /**
   * A human overriding a value the system set, without reversing anything.
   *
   * Recorded against the decision that set it so the correction rate counts
   * real corrections. Silent when no decision set the field: an edit to a value
   * a person typed in the first place is not a correction of anything.
   */
  async recordFieldCorrection(input: {
    organizationId: string;
    userId: string;
    kind: DecisionKind;
    field: string;
    systemValue: string | null;
    humanValue: string | null;
    dealId?: string | null;
    partyId?: string | null;
    consented?: boolean;
  }): Promise<void> {
    const [decision] = await this.db
      .select({ id: autonomousDecisions.autonomousDecisionId })
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, input.organizationId),
          eq(autonomousDecisions.kind, input.kind),
          eq(autonomousDecisions.outcome, "applied"),
          input.dealId ? eq(autonomousDecisions.dealId, input.dealId) : undefined,
          input.partyId ? eq(autonomousDecisions.partyId, input.partyId) : undefined,
        ),
      )
      .orderBy(desc(autonomousDecisions.decidedAt))
      .limit(1);

    if (!decision) return;

    await this.db.insert(autonomyCorrections).values({
      organizationId: input.organizationId,
      autonomousDecisionId: decision.id,
      kind: input.kind,
      correctionType: "edit",
      field: input.field,
      systemValue: input.systemValue,
      humanValue: input.humanValue,
      correctedByUserId: input.userId,
      consented: input.consented ?? false,
    });
  }
}
