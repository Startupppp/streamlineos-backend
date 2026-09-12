/**
 * Who or what recorded an activity, and how that reaches the audit log.
 *
 * Split out so the commands next door and the service can share one answer:
 * a machine action is written to the audit log with no user and a label naming
 * the system that acted. Two copies of that mapping would diverge the first time
 * a new machine writer appears.
 */

/**
 * Who or what recorded an activity.
 *
 * The same union the deal ledger uses, for the same reason: ticket 10's ingress
 * and ticket 12's extraction both write activities nobody typed, and a reader
 * has to be able to tell.
 */
export type ActivityActor =
  | { readonly kind: "human"; readonly userId: string }
  | { readonly kind: "system"; readonly label: string };

/**
 * `audit_logs.user_id` is nullable, and NULL is what a machine action writes.
 *
 * This used to write the sentinel string "system", on the belief that the repo
 * already did so elsewhere. Nothing ever created a user with that id, so every
 * one of those writes raised a foreign-key violation — swallowed by `log`,
 * fatal under `logCritical`. Migration 0663 made the column nullable and
 * requires the system case to name itself instead, which is the same shape this
 * module's own `ActivityActor` already has.
 */
export function auditActor(
  actor: ActivityActor,
): { userId: string; systemActor?: never } | { userId?: null; systemActor: string } {
  return actor.kind === "human"
    ? { userId: actor.userId }
    : { systemActor: actor.label };
}
