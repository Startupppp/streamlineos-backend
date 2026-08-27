import { clampHoldWindow } from "../../autonomy/hold-window";
import {
  evaluateGuardrails,
  type GuardrailVerdict,
  type SendTimeFacts,
} from "../../autonomy/send-guardrails";

/**
 * What a nurture sequence is allowed to do at each step.
 *
 * Phase 5, ticket 17. The ticket's own framing is "a sequence is many held
 * sends, not a bypass of the hold model", and this file exists because the
 * sequence runner in this directory was the bypass.
 *
 * What it did before, precisely, because the fix is only arguable against it:
 *
 * `CrmSequencesRunnerService.executeStep` called `CrmOutboundEmailService.send`
 * directly. No consent read at send time, no frequency cap, no working hours, no
 * hold window and no decision record — while every other outbound path in the
 * product goes through `evaluateGuardrails` and waits out a hold that a human
 * can cancel. So the one loop that sends the most messages, to the coldest
 * audience, on a schedule nobody watches, was the one loop with no guardrails.
 *
 * And `evaluateStopOn` handled `stopOn.replied` like this:
 *
 *     const unsupported = ["replied", "meeting_booked"] as const;
 *     for (const key of unsupported)
 *       if (stopOn[key] === true) logger.warn("stopOn key not supported", { key });
 *
 * A tenant ticks "stop when they reply", the UI accepts it, the database stores
 * it, and the runner writes a line to a log nobody reads and sends the next
 * message anyway. The ticket calls automation that talks over a person "the
 * single most damaging behaviour in this category"; it was configurable, it was
 * on, and it did nothing.
 *
 * ── The shape of the fix ───────────────────────────────────────────────────
 *
 * Two levels of decision, and keeping them apart is the whole design.
 *
 * A **sequence-level exit** ends the enrollment. A reply is the case that
 * matters: the fifth criterion says a reply exits "immediately, before the next
 * step is evaluated", which is stronger than blocking the send. `evaluateGuardrails`
 * already returns `reply-arrived`, but that blocks ONE message and leaves the
 * enrollment active — so next Tuesday it sends the step after, having been told
 * the conversation moved on. Exiting is what the ticket asks for and it is
 * checked first, before a step is even selected.
 *
 * A **step-level verdict** decides one send, and it is `evaluateGuardrails`
 * unchanged. Not a copy, not a subset: the same function every other loop calls,
 * which is what makes the third criterion — "frequency caps are shared with
 * every other loop" — true rather than aspirational. A sequence and a follow-up
 * cannot both fire because they consult the same cap over the same list of
 * recent sends to that party.
 */

/** Why an enrollment ended, in the order these are checked. */
export type SequenceExit =
  | "replied"
  | "unsubscribed"
  | "suppressed"
  | "converted"
  | "deal-closed"
  | "sequence-switched-off"
  | "completed";

export type SequenceTick =
  | { readonly kind: "exit"; readonly reason: SequenceExit }
  /** This step's message enters the held outbound path, cancellable on its own. */
  | { readonly kind: "hold-send"; readonly holdSeconds: number }
  /** Not a send — a task for a person. No guardrail applies; nothing leaves. */
  | { readonly kind: "internal-step" }
  /** The clock, not the recipient. Try again when the window opens. */
  | { readonly kind: "defer"; readonly notBefore: Date }
  /** A guardrail said no to this message, and the sequence continues. */
  | { readonly kind: "skip-step"; readonly reason: string };

/**
 * Which step types put something in front of a customer.
 *
 * `call_task` and `whatsapp_task` create a task for a human; nothing is sent, so
 * no guardrail applies and none is pretended to. Getting this list wrong in the
 * other direction is the dangerous one — a sending step treated as internal
 * would leave the guardrails behind — so the default below is that an unknown
 * step type is treated as sending.
 */
export const OUTBOUND_STEP_TYPES = ["email"] as const;
export const INTERNAL_STEP_TYPES = ["call_task", "whatsapp_task", "wait"] as const;

export function stepSends(stepType: string): boolean {
  return !INTERNAL_STEP_TYPES.includes(stepType as (typeof INTERNAL_STEP_TYPES)[number]);
}

/**
 * The hold a sequence step gets.
 *
 * Five minutes, and it is shorter than a cold-outbound hold for a reason: a
 * sequence message is one a human already approved as a template, so the hold is
 * there to make the send cancellable rather than to make it reviewed. It is not
 * zero, because the first criterion asks that each send be individually
 * stoppable, and a send with no window cannot be stopped by anybody.
 *
 * Passed through `clampHoldWindow` for the same reason every other window is:
 * the database has a range and a caller with a number outside it is a runtime
 * failure at the worst moment.
 */
export const SEQUENCE_HOLD_SECONDS = clampHoldWindow(300);

/**
 * Facts about the enrollment, distinct from facts about the send.
 *
 * Separate from `SendTimeFacts` on purpose: these end the sequence, those block
 * a message. Mixing them is how "a reply blocks this send" gets mistaken for "a
 * reply ends the sequence", which is the bug being fixed.
 */
export interface EnrollmentFacts {
  readonly now: Date;
  /** Whether the sequence itself is still switched on. */
  readonly sequenceActive: boolean;
  /** Anything inbound from this party since they were enrolled. */
  readonly repliedAt: Date | null;
  readonly enrolledAt: Date;
  /** They became a customer; the nurture is finished whatever step it is on. */
  readonly converted: boolean;
  /** The step this enrollment is on, or null when it has run out of steps. */
  readonly stepType: string | null;
}

/**
 * What happens to this enrollment on this tick.
 *
 * The order is the argument.
 *
 * A reply comes first — before the sequence's own switch, before consent, before
 * the step is even looked at — because everything after it is a decision about
 * a message, and once somebody has answered there is no message to decide about.
 * The person is talking to a human now.
 *
 * `>` rather than `>=` against `enrolledAt`, matching `outbound-eligibility.ts`
 * and `send-guardrails.ts`: a message stored in the same millisecond as the
 * enrolment is not a reply to it.
 *
 * Consent and suppression come from the send-time guardrails rather than being
 * re-checked here, which is the second criterion — "consent is checked at send
 * time, not at sequence creation". Somebody who opted out three steps ago is
 * caught by the guardrail on the step that would have reached them, not by a
 * flag copied onto the enrollment when it was made.
 */
export function evaluateSequenceTick(
  enrollment: EnrollmentFacts,
  send: SendTimeFacts | null,
): SequenceTick {
  if (enrollment.repliedAt && enrollment.repliedAt.getTime() > enrollment.enrolledAt.getTime())
    return { kind: "exit", reason: "replied" };

  if (enrollment.converted) return { kind: "exit", reason: "converted" };

  if (!enrollment.sequenceActive) return { kind: "exit", reason: "sequence-switched-off" };

  if (enrollment.stepType === null) return { kind: "exit", reason: "completed" };

  if (!stepSends(enrollment.stepType)) return { kind: "internal-step" };

  /*
    A sending step with no send-time snapshot is a programming error, not a
    condition to handle gracefully. Skipping the step would send nothing and
    advance the sequence, which looks like it worked; refusing to decide makes
    the caller's omission visible at the point it happened.
  */
  if (!send)
    throw new Error(
      "a sending sequence step needs a send-time snapshot; the caller must take one",
    );

  return fromGuardrails(evaluateGuardrails(send));
}

/**
 * A guardrail verdict, translated into what it means for the enrollment.
 *
 * Two of the blocks end the sequence rather than skipping a step, and the
 * distinction is about whether the reason will still be true next week.
 * An opt-out and a suppression are permanent facts about the recipient — a
 * sequence that skipped those steps one at a time would keep the enrollment
 * alive, keep evaluating it, and keep producing a decision to not send for
 * however many steps remain. Ending it says the true thing once.
 *
 * A frequency cap or a closed window is temporary and belongs to the message
 * rather than the relationship, so the sequence continues.
 */
function fromGuardrails(verdict: GuardrailVerdict): SequenceTick {
  if (verdict.allow) return { kind: "hold-send", holdSeconds: SEQUENCE_HOLD_SECONDS };

  if (verdict.action === "defer") return { kind: "defer", notBefore: verdict.notBefore };

  switch (verdict.reason) {
    case "opted-out":
    case "consent-expired":
      return { kind: "exit", reason: "unsubscribed" };
    case "suppressed":
      return { kind: "exit", reason: "suppressed" };
    case "reply-arrived":
      // Reachable when a reply lands between the enrollment snapshot and the
      // send snapshot. Treated as the sequence-level exit it is, not as a
      // skipped step — otherwise the race produces exactly the behaviour the
      // fifth criterion forbids.
      return { kind: "exit", reason: "replied" };
    case "deal-closed":
      return { kind: "exit", reason: "deal-closed" };
    case "class-stopped":
    case "frequency-cap":
    case "deferred-too-often":
      return { kind: "skip-step", reason: verdict.reason };
  }
}

/**
 * The only keys a step's configuration may contribute.
 *
 * The sixth criterion is "a sequence cannot be configured to bypass any
 * guardrail", and `crm_sequence_steps.config` is unstructured JSONB — so the
 * bypass would not arrive as a schema change anybody reviews. It would arrive as
 * somebody writing `if (cfg.ignoreWorkingHours) ...` in the runner, and a JSONB
 * column accepting a new key silently.
 *
 * This list is what the runner is permitted to read out of that column, and
 * `sequence-step.spec.ts` asserts both that it holds no guardrail-shaped key and
 * that the runner reads nothing outside it. Adding an override therefore means
 * adding it here, in a file whose whole subject is that overrides do not exist.
 */
export const STEP_CONFIG_KEYS = [
  "to",
  "subject",
  "body",
  "taskTitle",
  "assigneeId",
  "dueInDays",
] as const;

export type StepConfigKey = (typeof STEP_CONFIG_KEYS)[number];

/** A step's configuration, with anything nobody declared discarded. */
export function readStepConfig(
  config: Readonly<Record<string, unknown>> | null,
): Readonly<Record<StepConfigKey, unknown>> {
  const out = {} as Record<StepConfigKey, unknown>;
  for (const key of STEP_CONFIG_KEYS)
    if (config && Object.prototype.hasOwnProperty.call(config, key)) out[key] = config[key];
  return out;
}
