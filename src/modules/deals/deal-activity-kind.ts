import { ACTIVITY_KINDS, type ActivityKind } from "../../db/schema/crm/activities";

/**
 * The legacy deal vocabulary, mapped onto the one activity model.
 *
 * `deal_activities.type` is a free text column carrying its own vocabulary, which
 * overlaps the unified kinds but is not the same list. Two entries need a
 * decision rather than a lookup:
 *
 * - `document` has no unified kind. A document logged against a deal is a person
 *   recording that something was sent or received, so it becomes a `note` whose
 *   subject says so, rather than inventing a sixth kind for an attachment the
 *   platform does not store here.
 * - `stage_change` is deliberately absent. Ticket 08 models a transition in
 *   `deal_stage_transitions` with an actor union and a CHECK constraint; writing
 *   it a second time as an activity would give the same event two homes that can
 *   disagree, and an activity is something someone did rather than a state change.
 */

const LEGACY_TO_KIND: Record<string, ActivityKind> = {
  call: "call",
  email: "email",
  meeting: "meeting",
  note: "note",
  task: "task",
  document: "note",
};

/** Types the unified store deliberately does not accept. */
export const NOT_AN_ACTIVITY = new Set(["stage_change"]);

export function activityKindFor(legacyType: string): ActivityKind | null {
  const key = legacyType.trim().toLowerCase();
  if (NOT_AN_ACTIVITY.has(key)) return null;
  return LEGACY_TO_KIND[key] ?? null;
}

/**
 * A document carries no kind of its own, so the subject has to say what it was --
 * otherwise the timeline shows an untitled note and the reader learns nothing.
 */
export function subjectFor(legacyType: string, subject: string | null | undefined): string | null {
  const given = subject?.trim();
  if (given) return given;
  return legacyType.trim().toLowerCase() === "document" ? "Document" : null;
}

export function isActivityKind(value: string): value is ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(value);
}
