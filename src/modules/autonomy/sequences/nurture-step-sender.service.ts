import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { forEachOrg } from "../../../common/tenant";
import { OutboundService } from "../outbound.service";
import { resolveCadence, waitMsForStep } from "./nurture-cadence";
import type { NurtureStepDeps, NurtureSweepOutcome } from "./nurture-step-sender.types";
import { attemptNurtureStep, stopNurtureEnrolment } from "./lib/nurture-step-attempt";
import {
  loadCandidates,
  loadLastAttempts,
  loadLastInbound,
  loadSteps,
} from "./lib/nurture-sweep-reads";

export type { NurtureSweepOutcome } from "./nurture-step-sender.types";

/**
 * How many steps one organisation may actually attempt per tick.
 *
 * This one *is* a bill: every due step is a provider call inside
 * `composeAndHold`, paid before the send-time guardrails ever run. Deliberately
 * the same order of magnitude as the silence sweep's `PER_ORG_CANDIDATES`, and
 * lower than the examination cap, because the expensive half is the small half.
 */
const MAX_SENDS_PER_ORG = 50;

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
 *
 * The four batched reads a tick needs are `lib/nurture-sweep-reads.ts`;
 * claiming and composing a step, or ending an enrolment, is
 * `lib/nurture-step-attempt.ts`.
 */
@Injectable()
export class NurtureStepSenderService {
  private readonly logger = new Logger("NurtureSender");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly outbound: OutboundService,
  ) {}

  /** The ambient tenant transaction, the outbound loop and this class's logger, as the libs take them. */
  private get deps(): NurtureStepDeps {
    return { db: this.db, outbound: this.outbound, logger: this.logger };
  }

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

    const candidates = await loadCandidates(this.db, organizationId);
    outcome.considered = candidates.length;
    if (candidates.length === 0) return outcome;

    const [steps, lastAttemptAt, lastInboundAt] = await Promise.all([
      loadSteps(this.db, organizationId, candidates),
      loadLastAttempts(this.db, organizationId, candidates),
      loadLastInbound(this.db, organizationId, candidates),
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
        if (await stopNurtureEnrolment(this.db, organizationId, candidate, "exited", action.reason))
          outcome.exited += 1;
        continue;
      }

      if (action.action === "complete") {
        if (await stopNurtureEnrolment(this.db, organizationId, candidate, "completed", null))
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

      const attempted = await attemptNurtureStep(this.deps, organizationId, candidate, action.stepNumber);
      if (attempted === "held") outcome.held += 1;
      else if (attempted === "refused") outcome.refused += 1;
      else if (attempted === "failed") outcome.failed += 1;
    }

    return outcome;
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
