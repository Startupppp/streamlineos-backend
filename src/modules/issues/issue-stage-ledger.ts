import {
  TERMINAL_ISSUE_STAGES,
  type IssueStage,
  type StageActorKind,
} from "../../db/schema/crm/issue-records";

/**
 * What a stage move is allowed to be, and who is allowed to have made it.
 *
 * Pure on purpose. Whether escalating a complaint that nobody acknowledged is
 * legal, and whether a machine may record a move under its own name, are both
 * things that should be arguable against a test rather than against a running
 * database.
 */

/**
 * The actor, as the two kinds an actor can be.
 *
 * This is the shape `deal_stage_transitions` exists for. Ticket 08 built that
 * ledger because the only record of a stage change was a row whose `user_id`
 * referenced `users` and could not be null — so an action the system took either
 * went unrecorded or was filed under whichever person happened to be nearby.
 * Escalation inherits the problem exactly: an SLA breach that escalates a
 * complaint at 3am is a real, accountable act, and it did not have a person.
 *
 * A discriminated union rather than a nullable pair, because the invariant is
 * that a system actor NAMES ITSELF: `{ kind: "system", label: "sla-sweep" }`
 * cannot be constructed without a label, and 0290's CHECK refuses one anyway for
 * writers that never pass through this type.
 */
export type StageActor =
  | { readonly kind: "human"; readonly userId: string }
  | { readonly kind: "system"; readonly label: string };

export interface ActorColumns {
  readonly actorKind: StageActorKind;
  readonly actorUserId: string | null;
  readonly actorLabel: string | null;
}

/**
 * The actor, flattened onto the three columns the CHECK constrains.
 *
 * One place, so no caller ever writes `actorKind: "system"` beside a user id —
 * which is the row that makes a review feed lie, and the exact row the database
 * refuses.
 */
export function actorColumns(actor: StageActor): ActorColumns {
  return actor.kind === "human"
    ? { actorKind: "human", actorUserId: actor.userId, actorLabel: null }
    : { actorKind: "system", actorUserId: null, actorLabel: actor.label };
}

/**
 * Which stage may follow which.
 *
 * Reopening is legal from both terminal stages — a customer who says "this is
 * not fixed" is the single most important transition this table records, and a
 * model that forces a second complaint to be raised loses the connection between
 * the failure and the failed remedy.
 *
 * Nothing may transition to itself. A no-op move writes a ledger row saying
 * something happened when nothing did, and a ledger that records non-events is
 * one nobody trusts to record events.
 */
export const ALLOWED_STAGE_TRANSITIONS: Readonly<Record<IssueStage, readonly IssueStage[]>> = {
  open: ["acknowledged", "escalated", "resolved", "dismissed"],
  acknowledged: ["escalated", "resolved", "dismissed"],
  /** De-escalation is a real outcome: it was raised, looked at, and handed back. */
  escalated: ["acknowledged", "resolved", "dismissed"],
  resolved: ["open"],
  dismissed: ["open"],
};

export function canTransition(from: IssueStage, to: IssueStage): boolean {
  return ALLOWED_STAGE_TRANSITIONS[from].includes(to);
}

export function isTerminal(stage: IssueStage): boolean {
  return TERMINAL_ISSUE_STAGES.includes(stage);
}

export interface ClockStamps {
  readonly acknowledgedAt?: Date;
  readonly closedAt: Date | null;
}

/**
 * The clock columns a stage move sets.
 *
 * `acknowledgedAt` is written only by the move to `acknowledged`, and only the
 * first time. Escalating straight from `open` deliberately leaves it null,
 * because "escalated without anyone ever acknowledging it" is the most useful
 * thing this record can say about how a failure was handled — and stamping it on
 * escalation would erase exactly that.
 *
 * `closedAt` is set by the terminal stages and cleared by every other, which is
 * what keeps `chk_issue_records_closed` true through a reopen rather than
 * leaving each caller to remember.
 */
export function clockStamps(
  to: IssueStage,
  at: Date,
  acknowledgedAt: Date | null,
): ClockStamps {
  const closedAt = isTerminal(to) ? at : null;
  if (to === "acknowledged" && acknowledgedAt === null) return { acknowledgedAt: at, closedAt };
  return { closedAt };
}
