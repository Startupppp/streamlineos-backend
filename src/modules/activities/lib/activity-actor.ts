/**
 * Who or what recorded an activity, and how that reaches the audit log.
 *
 * Split out so the commands next door and the service can share one answer:
 * `audit_logs.user_id` is NOT NULL, so a machine action has to write a sentinel
 * there, and the label saying WHICH system did it rides in the entry metadata.
 * Two copies of that mapping would diverge the first time a new machine writer
 * appears.
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
 * `audit_logs.user_id` is NOT NULL, and the repo already writes this sentinel
 * for machine actions (recurring journals, KB page tree, the git integration).
 * The label that says WHICH system did it rides in the entry's metadata, and the
 * activity row itself keeps `actor_label` — this is only the audit column.
 */
export const SYSTEM_AUDIT_USER = "system";

export function auditActor(actor: ActivityActor): { userId: string; metadata: Record<string, unknown> } {
  return actor.kind === "human"
    ? { userId: actor.userId, metadata: {} }
    : { userId: SYSTEM_AUDIT_USER, metadata: { actorLabel: actor.label } };
}
