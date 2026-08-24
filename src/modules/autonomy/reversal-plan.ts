import type { DecisionKind, DecisionOutcome, ReversibilityClass } from "../../db/schema/crm/autonomous-decisions";

/**
 * Deciding whether an autonomous action can be taken back, and how.
 *
 * Pure, because the interesting part is the refusals rather than the writes.
 * The feed offers one-click reversal, and one click is only safe if the thing
 * being undone is still what the system left behind — otherwise the click
 * quietly destroys whatever a person did in the meantime.
 */

/** What the caller knows about the decision itself. */
export interface ReversibleDecision {
  readonly kind: DecisionKind;
  readonly outcome: DecisionOutcome;
  readonly reversibility: ReversibilityClass;
  readonly reversedAt: Date | null;
  readonly dealId: string | null;
  readonly activityId: string | null;
  readonly partyId: string | null;
  readonly decision: Record<string, unknown> | null;
}

/**
 * The current state of whatever the decision touched.
 *
 * `null` means the record is gone — already deleted by someone else, which is a
 * refusal rather than an error: there is nothing left to restore.
 */
export type TargetState =
  | { readonly kind: "deal"; readonly stage: string | null }
  | { readonly kind: "activity"; readonly deletedAt: Date | null; readonly completedAt: Date | null }
  | { readonly kind: "party"; readonly deletedAt: Date | null }
  | null;

export type ReversalRefusalReason =
  | "already-reversed"
  | "never-applied"
  | "not-reversible"
  | "target-missing"
  | "changed-since"
  | "unsupported-kind";

export interface ReversalRefusal {
  readonly ok: false;
  readonly reason: ReversalRefusalReason;
  /** One sentence a person reads in the feed, not a stack trace. */
  readonly explanation: string;
}

export type ReversalPlan =
  | { readonly ok: true; readonly action: "restore-stage"; readonly dealId: string; readonly toStage: string; readonly fromStage: string }
  | { readonly ok: true; readonly action: "delete-activity"; readonly activityId: string }
  | { readonly ok: true; readonly action: "delete-party"; readonly partyId: string };

export type ReversalDecision = ReversalPlan | ReversalRefusal;

const refuse = (reason: ReversalRefusalReason, explanation: string): ReversalRefusal => ({
  ok: false,
  reason,
  explanation,
});

/**
 * Whether this decision can be reversed right now, and what that would do.
 *
 * The order of the guards is the order of the questions a reviewer would ask:
 * has someone already undone it, did it actually happen, is this kind of thing
 * undoable at all, does the record still exist, and — last and most important —
 * is it still in the state the system left it in.
 */
export function planReversal(
  decision: ReversibleDecision,
  target: TargetState,
): ReversalDecision {
  if (decision.reversedAt !== null)
    return refuse("already-reversed", "This was already reversed.");

  /**
   * Only an applied decision changed anything.
   *
   * A skipped decision is a record of the system choosing not to act, which is
   * worth reading and meaningless to undo.
   */
  if (decision.outcome !== "applied")
    return refuse(
      "never-applied",
      `Nothing to undo — this decision was ${decision.outcome}, so no record was changed.`,
    );

  if (decision.reversibility !== "instant")
    return refuse(
      "not-reversible",
      decision.reversibility === "hold"
        ? "This is still inside its hold window — cancel it there instead of reversing it."
        : "This left the building and cannot be taken back; only a correction is possible.",
    );

  switch (decision.kind) {
    case "stage.advanced": {
      const fromStage = asString(decision.decision?.fromStage);
      const toStage = asString(decision.decision?.toStage);
      if (!decision.dealId || !fromStage || !toStage)
        return refuse("target-missing", "The record of what this changed is incomplete.");

      if (!target || target.kind !== "deal")
        return refuse("target-missing", "That deal no longer exists.");

      /**
       * The guard that makes one-click safe.
       *
       * If somebody has moved the deal on since, restoring the old stage would
       * silently overwrite their judgement with a reversal of something that is
       * no longer the current state. Refusing and saying so is the only honest
       * option: the reviewer can still change the stage by hand, having seen
       * what actually happened.
       */
      if (target.stage !== toStage)
        return refuse(
          "changed-since",
          `The deal has moved to ${target.stage ?? "no stage"} since, so reversing would undo somebody else's change rather than the system's.`,
        );

      return { ok: true, action: "restore-stage", dealId: decision.dealId, toStage: fromStage, fromStage: toStage };
    }

    case "task.extracted":
    case "activity.logged": {
      if (!decision.activityId)
        return refuse("target-missing", "The record of what this created is incomplete.");
      if (!target || target.kind !== "activity")
        return refuse("target-missing", "That entry no longer exists.");
      if (target.deletedAt !== null)
        return refuse("target-missing", "That entry has already been deleted.");

      /**
       * A completed task is somebody's work, not the system's mistake.
       *
       * Deleting it would remove the record that the thing was done. The
       * reviewer can still delete it deliberately from the timeline.
       */
      if (target.completedAt !== null)
        return refuse(
          "changed-since",
          "Somebody has already completed this task, so removing it would erase a record of work that was done.",
        );

      return { ok: true, action: "delete-activity", activityId: decision.activityId };
    }

    case "party.created": {
      if (!decision.partyId)
        return refuse("target-missing", "The record of what this created is incomplete.");
      if (!target || target.kind !== "party")
        return refuse("target-missing", "That party no longer exists.");
      if (target.deletedAt !== null)
        return refuse("target-missing", "That party has already been deleted.");

      return { ok: true, action: "delete-party", partyId: decision.partyId };
    }

    case "quote.sent":
      // Unreachable while quote.sent is classified `hold`, and kept as a real
      // branch so the exhaustiveness check below stays honest if that changes.
      return refuse("not-reversible", "A sent quote cannot be taken back.");

    default: {
      const exhaustive: never = decision.kind;
      return refuse("unsupported-kind", `Unknown action type: ${String(exhaustive)}`);
    }
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
