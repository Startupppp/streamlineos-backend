import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, max } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import {
  crmNurtureEnrollments,
  crmNurtureSequenceSteps,
  crmNurtureSequences,
  crmNurtureStepAttempts,
  relationshipStates,
} from "../../../db/schema";
import { forEachOrg } from "../../../common/tenant";
import { OutboundService } from "../outbound.service";
import { resolveCadence, waitMsForStep, type CadenceStep } from "./nurture-cadence";

/**
 * How many live enrolments one organisation is examined for per tick.
 *
 * Examining is cheap — four batched reads, then pure functions — so this is a
 * page size rather than a bill. Oldest enrolment first, so a tenant over the cap
 * makes progress from the front rather than starving whoever has been waiting
 * longest.
 */
const PER_ORG_CANDIDATES = 200;

/**
 * How many steps one organisation may actually attempt per tick.
 *
 * This one *is* a bill: every due step is a provider call inside
 * `composeAndHold`, paid before the send-time guardrails ever run. Deliberately
 * the same order of magnitude as the silence sweep's `PER_ORG_CANDIDATES`, and
 * lower than the examination cap, because the expensive half is the small half.
 */
const MAX_SENDS_PER_ORG = 50;

export interface NurtureSweepOutcome {
  /** Live enrolments looked at, whether or not anything was due. */
  considered: number;
  /** In cadence and not yet due. The steady state, and the number that should dominate. */
  waiting: number;
  /**
   * Due, but over this tick's send cap. Counted separately from `waiting`
   * because a number that stays above zero means the cap is now the thing
   * setting the cadence, and calling that "waiting" would hide it.
   */
  deferred: number;
  held: number;
  refused: number;
  exited: number;
  completed: number;
  /** A due step whose compose threw. Skipped, never retried — see `attemptStep`. */
  failed: number;
}

interface Candidate {
  readonly nurtureEnrollmentId: string;
  readonly nurtureSequenceId: string;
  readonly partyId: string;
  readonly dealId: number | null;
  readonly currentStep: number;
  readonly enrolledAt: Date;
  readonly updatedAt: Date;
  readonly sequenceStatus: string;
  readonly sequenceDeletedAt: Date | null;
}

/**
 * The half of the nurture engine that actually moves: it finds the enrolments
 * whose next step has come round and hands each one to the outbound loop.
 *
 * It decides two things and no more — which enrolments to look at, and how many
 * of them may cost money this tick. Everything else is deferred:
 * `resolveCadence` says what a wake means, `waitMsForStep` says when a step is
 * due, and `OutboundService.composeAndHold` judges the relationship, writes the
 * message, applies its confidence threshold and opens the hold window. Nothing
 * here drafts, addresses or sends, and there is no path through this file that
 * puts a message on the wire without the hold — which is the property
 * `nurture-sequences.ts` was designed around and the one that makes this engine
 * different from `crm/automation-studio`'s.
 *
 * No cron endpoint lives here. This is a service the scheduler calls, in the
 * shape `CronCrmAutonomyService` already uses for the silence sweep.
 */
@Injectable()
export class NurtureStepSenderService {
  private readonly logger = new Logger("NurtureSender");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly outbound: OutboundService,
  ) {}

  /**
   * Every organisation, each inside its own tenant transaction.
   *
   * `forEachOrg` rather than a cross-org discovery query because all four
   * nurture tables are under RLS: a sweep with no tenant GUC reads nothing and
   * fails closed with `42501`, so discovery has to happen inside the per-org
   * loop. One organisation failing rolls back alone and the loop continues.
   */
  async sweepDueSteps(): Promise<
    NurtureSweepOutcome & { organizations: number; organizationsFailed: number }
  > {
    const total = emptyOutcome();

    const result = await forEachOrg(this.db, "crm-nurture-steps", async (_tx, orgId) => {
      const outcome = await this.runDueStepsForOrg(orgId);
      total.considered += outcome.considered;
      total.waiting += outcome.waiting;
      total.deferred += outcome.deferred;
      total.held += outcome.held;
      total.refused += outcome.refused;
      total.exited += outcome.exited;
      total.completed += outcome.completed;
      total.failed += outcome.failed;
    });

    /**
     * `failed` means two different things at two levels, and they must not share
     * a name: spreading the step-level count and then overwriting it with the
     * org-level one discards the number that says a provider is throwing, so a
     * sweep failing every compose would report zero failures forever.
     */
    return { ...total, organizations: result.succeeded, organizationsFailed: result.failed };
  }

  /**
   * One organisation's due steps.
   *
   * Requires an ambient tenant context — a request's, or the one `forEachOrg`
   * opens. It reads no `organizations` row of its own and opens no transaction,
   * so calling it without one reads nothing rather than reading another tenant.
   */
  async runDueStepsForOrg(
    organizationId: string,
    options: { readonly maxSends?: number } = {},
  ): Promise<NurtureSweepOutcome> {
    const maxSends = options.maxSends ?? MAX_SENDS_PER_ORG;
    const outcome = emptyOutcome();

    const candidates = await this.loadCandidates(organizationId);
    outcome.considered = candidates.length;
    if (candidates.length === 0) return outcome;

    const [steps, lastAttemptAt, lastInboundAt] = await Promise.all([
      this.loadSteps(organizationId, candidates),
      this.loadLastAttempts(organizationId, candidates),
      this.loadLastInbound(organizationId, candidates),
    ]);

    const now = Date.now();
    let sends = 0;

    for (const candidate of candidates) {
      const cadence = steps.get(candidate.nurtureSequenceId) ?? [];

      const action = resolveCadence({
        // Literal because `loadCandidates` filters on it. The field exists for
        // the durable run, which re-reads a row it was started with days ago.
        enrolmentStatus: "active",
        sequenceStatus: candidate.sequenceStatus,
        sequenceDeleted: candidate.sequenceDeletedAt !== null,
        currentStep: candidate.currentStep,
        enrolledAt: candidate.enrolledAt,
        lastInboundAt: lastInboundAt.get(candidate.partyId) ?? null,
        totalSteps: cadence.length,
      });

      if (action.action === "stop") continue;

      if (action.action === "exit") {
        if (await this.stopEnrolment(organizationId, candidate, "exited", action.reason))
          outcome.exited += 1;
        continue;
      }

      if (action.action === "complete") {
        if (await this.stopEnrolment(organizationId, candidate, "completed", null))
          outcome.completed += 1;
        continue;
      }

      /**
       * The clock, measured from the last thing that happened to this enrolment.
       *
       * The base is the previous step's attempt, falling back to the enrolment
       * for step one. The second fallback — `updatedAt` — covers the enrolment
       * whose step was claimed but whose attempt row never landed, which is what
       * a crash mid-step leaves behind. Falling back to `enrolledAt` there would
       * make every remaining step of that enrolment instantly due.
       */
      const base =
        lastAttemptAt.get(candidate.nurtureEnrollmentId) ??
        (candidate.currentStep > 0 ? candidate.updatedAt : candidate.enrolledAt);

      if (now - base.getTime() < waitMsForStep(cadence, action.stepNumber)) {
        outcome.waiting += 1;
        continue;
      }

      /**
       * `continue` rather than `break`: the cap is on the half that costs money,
       * and the rest of this pass is free. Stopping the loop outright would let
       * a tenant with fifty due steps postpone somebody's exit-on-reply — the
       * one thing in this file that should never wait on a budget.
       */
      if (sends >= maxSends) {
        outcome.deferred += 1;
        continue;
      }
      sends += 1;

      const attempted = await this.attemptStep(organizationId, candidate, action.stepNumber);
      if (attempted === "held") outcome.held += 1;
      else if (attempted === "refused") outcome.refused += 1;
      else if (attempted === "failed") outcome.failed += 1;
    }

    return outcome;
  }

  /**
   * Claim the step, compose, record what came of it.
   *
   * The claim is a conditional advance of `current_step`, and it happens BEFORE
   * the provider call rather than after. That ordering is the whole safety
   * argument: two ticks overlapping — a slow sweep and the next one, or two
   * workers — resolve to one winner at the database, and the loser does not
   * draft. Written the other way round, both would compose, both would pay, and
   * both would hold a differently worded message to the same customer.
   *
   * A crash between the claim and the attempt row therefore loses a step rather
   * than repeating one, and the same is true of a compose that throws: the claim
   * is not rolled back. `composeAndHold` commits its hold in its own
   * transaction, so a throw is not proof no message is waiting, and between
   * skipping a follow-up and sending a second one to somebody who may already
   * have the first, only the second is unrecallable.
   */
  private async attemptStep(
    organizationId: string,
    candidate: Candidate,
    stepNumber: number,
  ): Promise<"held" | "refused" | "failed" | "lost"> {
    const [claimed] = await this.db
      .update(crmNurtureEnrollments)
      .set({ currentStep: stepNumber })
      .where(
        and(
          eq(crmNurtureEnrollments.organizationId, organizationId),
          eq(crmNurtureEnrollments.nurtureEnrollmentId, candidate.nurtureEnrollmentId),
          eq(crmNurtureEnrollments.status, "active"),
          eq(crmNurtureEnrollments.currentStep, stepNumber - 1),
        ),
      )
      .returning({ id: crmNurtureEnrollments.nurtureEnrollmentId });

    if (!claimed) return "lost";

    let outcome: "held" | "refused";
    let reason: string | null = null;
    let outboundMessageId: string | null = null;
    let autonomyHoldId: string | null = null;

    try {
      const composed = await this.outbound.composeAndHold({
        organizationId,
        partyId: candidate.partyId,
        // `deal_id` is an integer column against `deals.id`; `composeAndHold`
        // takes the identifier as a string, as every other caller passes it.
        dealId: candidate.dealId === null ? null : String(candidate.dealId),
      });

      if (composed.held) {
        outcome = "held";
        outboundMessageId = composed.outboundMessageId;
        autonomyHoldId = composed.autonomyHoldId;
      } else {
        outcome = "refused";
        reason = composed.reason;
      }
    } catch (error) {
      this.logger.error(
        `step ${stepNumber} of enrolment ${candidate.nurtureEnrollmentId} could not be composed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return "failed";
    }

    /**
     * `onConflictDoNothing` against `uniq_crm_nurture_step_attempts_step`.
     *
     * The claim already made a second attempt at this step impossible, so a
     * conflict here means a row this sweep cannot explain — and the useful
     * response is to leave the existing record alone rather than to fail the
     * tick over bookkeeping for a message that has already been held.
     */
    await this.db
      .insert(crmNurtureStepAttempts)
      .values({
        organizationId,
        nurtureEnrollmentId: candidate.nurtureEnrollmentId,
        stepNumber,
        outcome,
        reason,
        outboundMessageId,
        autonomyHoldId,
      })
      .onConflictDoNothing();

    return outcome;
  }

  /**
   * End an enrolment, conditionally on it still being live.
   *
   * `WHERE status = 'active'` for the reason `SequenceReplyExitService` gives
   * for the same predicate: a reply landing in the same second must win, and an
   * unconditional write would replace `replied` with `sequence-paused` — burying
   * the one outcome the feature is judged on under the one that merely happened
   * to be checked second.
   */
  private async stopEnrolment(
    organizationId: string,
    candidate: Candidate,
    status: "exited" | "completed",
    exitReason: string | null,
  ): Promise<boolean> {
    const [stopped] = await this.db
      .update(crmNurtureEnrollments)
      .set({ status, exitReason, exitedAt: new Date() })
      .where(
        and(
          eq(crmNurtureEnrollments.organizationId, organizationId),
          eq(crmNurtureEnrollments.nurtureEnrollmentId, candidate.nurtureEnrollmentId),
          eq(crmNurtureEnrollments.status, "active"),
        ),
      )
      .returning({ id: crmNurtureEnrollments.nurtureEnrollmentId });

    return Boolean(stopped);
  }

  // ── The four reads a tick needs, batched ──────────────────────────────────

  /**
   * Live enrolments with the state of the sequence behind them.
   *
   * Deliberately not filtered to active sequences. A paused or deleted one still
   * has to be looked at, because looking at it is how its enrolments exit — and
   * `resolveCadence` needs the sequence's status to say so with the right reason.
   */
  private async loadCandidates(organizationId: string): Promise<Candidate[]> {
    return this.db
      .select({
        nurtureEnrollmentId: crmNurtureEnrollments.nurtureEnrollmentId,
        nurtureSequenceId: crmNurtureEnrollments.nurtureSequenceId,
        partyId: crmNurtureEnrollments.partyId,
        dealId: crmNurtureEnrollments.dealId,
        currentStep: crmNurtureEnrollments.currentStep,
        enrolledAt: crmNurtureEnrollments.enrolledAt,
        updatedAt: crmNurtureEnrollments.updatedAt,
        sequenceStatus: crmNurtureSequences.status,
        sequenceDeletedAt: crmNurtureSequences.deletedAt,
      })
      .from(crmNurtureEnrollments)
      .innerJoin(
        crmNurtureSequences,
        and(
          eq(crmNurtureSequences.nurtureSequenceId, crmNurtureEnrollments.nurtureSequenceId),
          eq(crmNurtureSequences.organizationId, organizationId),
        ),
      )
      .where(
        and(
          eq(crmNurtureEnrollments.organizationId, organizationId),
          eq(crmNurtureEnrollments.status, "active"),
        ),
      )
      .orderBy(asc(crmNurtureEnrollments.enrolledAt))
      .limit(PER_ORG_CANDIDATES);
  }

  private async loadSteps(
    organizationId: string,
    candidates: readonly Candidate[],
  ): Promise<Map<string, CadenceStep[]>> {
    const sequenceIds = [...new Set(candidates.map((c) => c.nurtureSequenceId))];

    const rows = await this.db
      .select({
        nurtureSequenceId: crmNurtureSequenceSteps.nurtureSequenceId,
        stepNumber: crmNurtureSequenceSteps.stepNumber,
        waitHours: crmNurtureSequenceSteps.waitHours,
      })
      .from(crmNurtureSequenceSteps)
      .where(
        and(
          eq(crmNurtureSequenceSteps.organizationId, organizationId),
          inArray(crmNurtureSequenceSteps.nurtureSequenceId, sequenceIds),
        ),
      )
      .orderBy(asc(crmNurtureSequenceSteps.stepNumber));

    const bySequence = new Map<string, CadenceStep[]>();
    for (const row of rows) {
      const existing = bySequence.get(row.nurtureSequenceId);
      const step: CadenceStep = { stepNumber: row.stepNumber, waitHours: row.waitHours };
      if (existing) existing.push(step);
      else bySequence.set(row.nurtureSequenceId, [step]);
    }

    return bySequence;
  }

  /** When each enrolment last attempted anything, in one grouped read. */
  private async loadLastAttempts(
    organizationId: string,
    candidates: readonly Candidate[],
  ): Promise<Map<string, Date>> {
    const rows = await this.db
      .select({
        nurtureEnrollmentId: crmNurtureStepAttempts.nurtureEnrollmentId,
        lastAt: max(crmNurtureStepAttempts.createdAt),
      })
      .from(crmNurtureStepAttempts)
      .where(
        and(
          eq(crmNurtureStepAttempts.organizationId, organizationId),
          inArray(
            crmNurtureStepAttempts.nurtureEnrollmentId,
            candidates.map((c) => c.nurtureEnrollmentId),
          ),
        ),
      )
      .groupBy(crmNurtureStepAttempts.nurtureEnrollmentId);

    const byEnrolment = new Map<string, Date>();
    for (const row of rows) if (row.lastAt) byEnrolment.set(row.nurtureEnrollmentId, row.lastAt);
    return byEnrolment;
  }

  /**
   * `relationship_states.last_inbound_at`, read directly and in one statement.
   *
   * The platform's existing answer to "have they said anything to us", and the
   * same column `OutboundService.sendTimeFacts` reads for its own reply
   * guardrail — `nurture-cadence.ts` names it explicitly rather than letting a
   * second definition of "a reply" grow beside it. Read here rather than through
   * `RelationshipStateService.read`, which answers for one anchor at a time and
   * would make a sweep over two hundred enrolments two hundred queries.
   */
  private async loadLastInbound(
    organizationId: string,
    candidates: readonly Candidate[],
  ): Promise<Map<string, Date>> {
    const rows = await this.db
      .select({
        partyId: relationshipStates.partyId,
        lastInboundAt: relationshipStates.lastInboundAt,
      })
      .from(relationshipStates)
      .where(
        and(
          eq(relationshipStates.organizationId, organizationId),
          isNotNull(relationshipStates.partyId),
          isNotNull(relationshipStates.lastInboundAt),
          inArray(
            relationshipStates.partyId,
            candidates.map((c) => c.partyId),
          ),
        ),
      );

    const byParty = new Map<string, Date>();
    for (const row of rows) {
      if (!row.partyId || !row.lastInboundAt) continue;
      /**
       * The latest, where a party is anchored more than once.
       *
       * `relationship_states` is an exclusive arc — a row is anchored to a party
       * or to a deal — and nothing stops a party carrying several rows. Taking
       * whichever the scan returned last would make "have they replied" depend
       * on row order, and the safe reading of a reply is the most recent one.
       */
      const known = byParty.get(row.partyId);
      if (!known || row.lastInboundAt > known) byParty.set(row.partyId, row.lastInboundAt);
    }

    return byParty;
  }
}

function emptyOutcome(): NurtureSweepOutcome {
  return {
    considered: 0,
    waiting: 0,
    deferred: 0,
    held: 0,
    refused: 0,
    exited: 0,
    completed: 0,
    failed: 0,
  };
}
