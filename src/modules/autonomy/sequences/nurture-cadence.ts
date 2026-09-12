import { PARTY_FREQUENCY_CAPS } from "../send-guardrails";

/**
 * When the next step of a sequence is due, and when the sequence must stop.
 *
 * Pure, for the same reason the six files beside `outbound.service.ts` are pure:
 * every rule here is one that has to be arguable without a tenant and a network,
 * and the branch that matters most — a reply arriving mid-cadence — is the one
 * nobody can conveniently reproduce against a database.
 *
 * ── Why this exists beside `crm-sequences.service.ts` rather than inside it ──
 *
 * `crm/automation-studio/crm-sequences.service.ts` and its runner already model
 * sequences, steps and enrolments. They are not extended here, and the decision
 * was made on three facts read out of those two files rather than on taste:
 *
 *  1. `CrmSequencesRunnerService.executeStep` sends an `email` step by calling
 *     `CrmOutboundEmailService.send(orgId, { to, subject, html })` with values
 *     read straight out of `crm_sequence_steps.config`. No hold is placed, no
 *     `evaluateGuardrails` snapshot is taken, the cold gate never runs, and no
 *     row is written to `autonomous_decisions`. Every guardrail in
 *     `send-guardrails.ts` is bypassed, not merely unconfigured.
 *  2. `evaluateStopOn` treats `replied` and `meeting_booked` as unsupported and
 *     logs a warning. Exit-on-reply is not weak there — it is absent.
 *  3. A step in that model CARRIES the message. `composeAndHold` does not accept
 *     one: it judges the relationship, drafts from it, and refuses on its own
 *     eligibility and confidence rules. There is nowhere for `config.body` to go.
 *
 * (1) and (2) are fixable in place. (3) is not: the two engines disagree about
 * what a step *is*, and the older one's semantics are load-bearing for whatever
 * enrolments are already in flight — changing them would alter, mid-cadence,
 * what an already-enrolled customer receives. So this is a second engine, and
 * saying so plainly is part of the deal: the automation-studio engine still
 * exists and still bypasses the hold model. Nothing in this ticket closed that.
 * The intended end state is that engine deprecated onto this one, and it is not
 * done here because `crm/automation-studio` is outside this change.
 */

/**
 * The tightest cadence that can actually send, derived rather than chosen.
 *
 * `PARTY_FREQUENCY_CAPS` allows one send per 5 days and three per 30. The
 * binding constraint over a long cadence is the *sparsest* of them — 30/3 is one
 * per 10 days, which is stricter than 5/1 — so any interval below that schedules
 * a step `evaluateGuardrails` is guaranteed to refuse with `frequency-cap`.
 *
 * A refused step is not harmless. `composeAndHold` pays a provider for the draft
 * before the send-time guardrails ever run, so a 24-hour cadence bills the
 * tenant for a message a week and delivers none of it, while the sequence
 * reports itself as running. Deriving the floor from the caps rather than
 * writing `240` here means widening a cap loosens this automatically, and
 * tightening one cannot leave a legal cadence behind that no longer sends.
 */
export const MIN_STEP_WAIT_HOURS = Math.max(
  ...PARTY_FREQUENCY_CAPS.map((cap) => Math.ceil((cap.windowDays / cap.max) * 24)),
);

/** Ninety days. Past that the "follow-up" is a cold approach wearing its badge. */
export const MAX_STEP_WAIT_HOURS = 90 * 24;

/**
 * How many steps one sequence may have.
 *
 * At the floor above this is a little over four months of contact. A sequence
 * longer than that is not a nurture, it is a subscription nobody signed up for.
 */
export const MAX_SEQUENCE_STEPS = 12;

/**
 * Why an enrolment stopped early.
 *
 * `replied` first because it is the one the feature is judged on. Kept as a
 * closed vocabulary rather than free text so the reason can be counted: "how
 * often does a sequence get talked out of itself by a reply" is the question
 * that tells a tenant whether the cadence is any good.
 */
export const NURTURE_EXIT_REASONS = [
  "replied",
  "sequence-paused",
  "sequence-deleted",
  "manual-stop",
  "no-steps",
] as const;
export type NurtureExitReason = (typeof NURTURE_EXIT_REASONS)[number];

export interface CadenceStep {
  readonly stepNumber: number;
  readonly waitHours: number;
}

/**
 * The enrolment as the workflow finds it when it wakes, days later.
 *
 * Every field is re-read at wake rather than carried from enrolment. A run that
 * trusted what it was started with would be acting on a reading of the world
 * from before the wait — which is the mistake `send-guardrails.ts` was written
 * to stop the outbound loop making, arriving one level up.
 */
export interface EnrolmentSnapshot {
  readonly enrolmentStatus: string;
  readonly sequenceStatus: string;
  readonly sequenceDeleted: boolean;
  readonly currentStep: number;
  readonly enrolledAt: Date;
  /**
   * `relationship_states.last_inbound_at` — the platform's existing answer to
   * "have they said anything to us", and the same column
   * `OutboundService.sendTimeFacts` reads for its `repliedAt` guardrail.
   *
   * Deliberately not a second definition of what a reply is. Two of those would
   * eventually disagree, and the day they did, one of them would be the one that
   * kept a sequence running over somebody who had answered.
   */
  readonly lastInboundAt: Date | null;
  readonly totalSteps: number;
}

export type CadenceAction =
  | { readonly action: "send"; readonly stepNumber: number }
  | { readonly action: "exit"; readonly reason: NurtureExitReason }
  | { readonly action: "complete" }
  /** Already stopped by something else. Nothing to do and nothing to record. */
  | { readonly action: "stop"; readonly reason: string };

/**
 * Whether an inbound message from them counts as an exit for this enrolment.
 *
 * Strictly after enrolment. A customer who replied last Tuesday and was
 * deliberately enrolled on Wednesday has not replied *to the sequence*, and
 * treating that as an exit would make every enrolment of an engaged customer
 * terminate on its first wake — which reads exactly like the feature being
 * broken rather than like it being careful.
 */
export function repliedSinceEnrolment(snapshot: {
  readonly enrolledAt: Date;
  readonly lastInboundAt: Date | null;
}): boolean {
  if (!snapshot.lastInboundAt) return false;
  return snapshot.lastInboundAt.getTime() > snapshot.enrolledAt.getTime();
}

/**
 * What to do at a wake, in the order the reasons outrank each other.
 *
 * The reply is checked FIRST — before the sequence's own status, before the step
 * count, before anything. Not for efficiency: for what it means when two reasons
 * are both true. If a sequence is paused *and* the customer replied, the
 * enrolment must be recorded as having ended because they answered, because that
 * is the fact anybody reviewing this will need, and "paused" would bury it.
 *
 * `stop` rather than `exit` when the enrolment is already inactive, because
 * something else already wrote a reason and overwriting it would lose it.
 */
export function resolveCadence(snapshot: EnrolmentSnapshot): CadenceAction {
  if (repliedSinceEnrolment(snapshot)) return { action: "exit", reason: "replied" };

  if (snapshot.enrolmentStatus !== "active")
    return { action: "stop", reason: `enrolment-${snapshot.enrolmentStatus}` };

  if (snapshot.sequenceDeleted) return { action: "exit", reason: "sequence-deleted" };

  /**
   * A paused sequence stops its enrolments rather than freezing them.
   *
   * Freezing is the tempting option and it is the wrong one: a frozen enrolment
   * needs something to thaw it, which means a poller, which means a second way
   * for a message to leave. Between "an operator has to re-enrol after a pause"
   * and "a pause silently queues up everything it deferred", the first is the
   * direction to be wrong in for an action that cannot be recalled.
   */
  if (snapshot.sequenceStatus !== "active") return { action: "exit", reason: "sequence-paused" };

  if (snapshot.totalSteps === 0) return { action: "exit", reason: "no-steps" };

  const next = snapshot.currentStep + 1;
  if (next > snapshot.totalSteps) return { action: "complete" };

  return { action: "send", stepNumber: next };
}

/**
 * The wait before a step, clamped into the range that can actually send.
 *
 * Clamped rather than rejected, because this is also applied to rows already in
 * the table. A sequence authored before the floor moved must not become a run
 * that throws on wake — it must become a run that waits longer.
 */
export function clampWaitHours(hours: number): number {
  if (!Number.isFinite(hours)) return MIN_STEP_WAIT_HOURS;
  return Math.min(MAX_STEP_WAIT_HOURS, Math.max(MIN_STEP_WAIT_HOURS, Math.floor(hours)));
}

/** Milliseconds to sleep before attempting `stepNumber`, from the steps as stored. */
export function waitMsForStep(steps: readonly CadenceStep[], stepNumber: number): number {
  const step = steps.find((candidate) => candidate.stepNumber === stepNumber);
  if (!step) return 0;
  return clampWaitHours(step.waitHours) * 3_600_000;
}

/**
 * Step numbers are 1-based and dense, and this is where that is enforced.
 *
 * `resolveCadence` advances by adding one, so a sequence numbered 1, 2, 4 would
 * look up step 3, find nothing, sleep zero milliseconds and send immediately —
 * turning an authoring slip into two messages in a row. Refusing the gap at
 * write time is cheaper than defending against it at every read.
 */
export function stepNumbersAreDense(steps: readonly CadenceStep[]): boolean {
  const sorted = [...steps].map((step) => step.stepNumber).sort((a, b) => a - b);
  return sorted.every((value, index) => value === index + 1);
}
