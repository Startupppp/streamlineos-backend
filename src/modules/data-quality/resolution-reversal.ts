import type { ReversibilityClass } from "../../db/schema/crm/autonomous-decisions";
import type { ResolutionAction } from "../../db/schema/crm/data-quality";

/**
 * Deciding whether a bulk resolution can be taken back.
 *
 * Pure, and the refusals are the point. A reversibility class that only ever
 * describes something is documentation; this is the function that makes it bite,
 * and the surface offering "undo" is only honest because this refuses.
 *
 * The same shape as `autonomy/reversal-plan.ts` deliberately — same vocabulary,
 * same discriminated result, so the two undo paths do not diverge in behaviour
 * while looking alike.
 */

export interface ReversibleResolution {
  readonly action: ResolutionAction;
  readonly reversibility: ReversibilityClass;
  /** Only ever set for `hold`; the instant the window closes. */
  readonly holdUntil: Date | null;
  readonly reversedAt: Date | null;
  /** How many findings actually moved. Nothing moved, nothing to undo. */
  readonly resolvedCount: number;
}

export type ResolutionRefusalReason =
  | "already-reversed"
  | "nothing-resolved"
  | "class-refuses"
  | "hold-expired"
  | "hold-window-missing";

export interface ResolutionReversalRefusal {
  readonly ok: false;
  readonly reason: ResolutionRefusalReason;
  /** One sentence a person reads, never a stack trace. */
  readonly explanation: string;
}

export type ResolutionReversalPlan =
  | {
      readonly ok: true;
      /** Undo the record changes, then reopen the findings. */
      readonly action: "revert-and-reopen";
    }
  | {
      readonly ok: true;
      /** Nothing touched a record, so reopening the findings is the whole undo. */
      readonly action: "reopen";
    };

export type ResolutionReversalDecision = ResolutionReversalPlan | ResolutionReversalRefusal;

const refuse = (
  reason: ResolutionRefusalReason,
  explanation: string,
): ResolutionReversalRefusal => ({ ok: false, reason, explanation });

/**
 * Whether this decision can be reversed right now, and what that would do.
 *
 * The guards run in the order a person would ask the questions: has someone
 * already undone it, did anything actually happen, and — the one the whole
 * vocabulary exists for — does its class permit an undo at all.
 *
 * `irreversible` refuses unconditionally rather than trying and failing. A
 * remedy that reached a customer is not undone by a database write, and offering
 * the button anyway teaches people the undo works when it does not.
 *
 * `hold` refuses once the window has passed, and refuses a hold with no window
 * at all: a hold whose deadline is unknown is either still open forever or
 * already closed, and there is no safe way to guess which.
 */
export function planResolutionReversal(
  resolution: ReversibleResolution,
  now: Date,
): ResolutionReversalDecision {
  if (resolution.reversedAt !== null)
    return refuse("already-reversed", "This decision was already reversed.");

  if (resolution.resolvedCount <= 0)
    return refuse("nothing-resolved", "This decision changed nothing, so there is nothing to undo.");

  switch (resolution.reversibility) {
    case "irreversible":
      return refuse(
        "class-refuses",
        "This decision is not reversible — the only remedy is a correction.",
      );

    case "hold": {
      if (resolution.holdUntil === null)
        return refuse(
          "hold-window-missing",
          "This decision was held without a deadline, so it cannot be cancelled safely.",
        );

      if (now.getTime() >= resolution.holdUntil.getTime())
        return refuse("hold-expired", "The window for cancelling this decision has passed.");

      return { ok: true, action: "revert-and-reopen" };
    }

    case "instant":
      /**
       * A dismissal never touched a record, so there is nothing to reverse in
       * the data — only the queue state. Saying so lets the caller skip the
       * executor entirely rather than dispatching a no-op per finding.
       */
      return resolution.action === "dismiss"
        ? { ok: true, action: "reopen" }
        : { ok: true, action: "revert-and-reopen" };

    default: {
      return refuse("class-refuses", `Unknown reversibility class ${String(resolution.reversibility satisfies never)}.`);
    }
  }
}
