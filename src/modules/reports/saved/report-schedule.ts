import type { SavedReport, Viewer, ViewerAccess } from "./saved-report";
import { isSharedWith } from "./saved-report";

/**
 * A report that arrives without being asked for.
 *
 * Phase 5, ticket 13, second criterion. Scheduling looks like the least
 * interesting third of "saved, shared and scheduled" and is in fact where
 * ticket 12 goes to die, because a schedule breaks the assumption everything in
 * `saved-report.ts` rests on: that there is a viewer present, whose access can
 * be resolved at the moment they look.
 *
 * A scheduled report has no viewer at the moment it runs. It has an author who
 * set it up weeks ago and a list of recipients who are asleep. If it runs as the
 * author and posts the result to the recipients, then every access rule in the
 * product has been replaced by "what the author could see in the past", which is
 * precisely the leak ticket 12 exists to close — arriving through the one door
 * that ticket left open.
 *
 * So a schedule does not produce A result. It produces one result per recipient,
 * each compiled against that recipient's own scope at the moment the schedule
 * fires. That is more expensive, and the expense is the point: the cheap version
 * is the insecure one, and there is no third option that is both.
 *
 * Two consequences worth stating because they surprise people:
 *
 * Two recipients of the same scheduled report legitimately receive different
 * numbers, and the delivery says so — a total computed at `own` scope is that
 * person's total, not the company's, and a recipient who does not know that will
 * quote it in a meeting.
 *
 * A recipient who has lost access receives a message saying so rather than an
 * empty table, for the reason given in `requesterForViewer`: an empty report
 * reads as "nothing happened", which is a false statement about the business
 * rather than a true statement about permissions.
 */

/**
 * How often a schedule may fire.
 *
 * A closed set rather than a cron expression. Cron is expressive enough to say
 * "every minute", which on a per-recipient recompilation is a way to spend a
 * tenant's entire query budget on one report, and expressive enough to be got
 * wrong silently by the person writing it. Nobody has ever needed a report at
 * 04:17 on the third Tuesday.
 */
export const SCHEDULE_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

export interface ReportSchedule {
  readonly scheduleId: string;
  readonly reportId: string;
  readonly orgId: string;
  readonly cadence: ScheduleCadence;
  /** Local hour of day, in the tenant's zone. */
  readonly hour: number;
  /** Who set it up. Their access governs nothing but their own copy. */
  readonly createdByUserId: string;
  readonly recipientUserIds: readonly string[];
  readonly active: boolean;
}

export type RecipientOutcome =
  | { readonly kind: "send"; readonly userId: string; readonly scopeUsed: string }
  | { readonly kind: "tell-them-access-changed"; readonly userId: string; readonly why: string }
  | { readonly kind: "drop"; readonly userId: string; readonly why: string };

/**
 * What to do for each recipient, decided per recipient.
 *
 * A pure function of the schedule and a snapshot of each recipient's access, so
 * the rule is arguable without a mail server. The caller's job is to take that
 * snapshot at fire time — not at schedule time, for the same reason the send
 * guardrails read consent at send time: every fact here can change between the
 * two, and the only reading that matters is the one at delivery.
 */
export function planDelivery(
  schedule: ReportSchedule,
  report: SavedReport,
  accessByUser: ReadonlyMap<string, ViewerAccess>,
): readonly RecipientOutcome[] {
  if (!schedule.active) return [];

  return schedule.recipientUserIds.map((userId): RecipientOutcome => {
    const viewer: Viewer = { userId, orgId: schedule.orgId };
    const access = accessByUser.get(userId);

    /*
      No snapshot for this person means they are no longer a member of the
      organisation — a leaver. Dropped silently rather than told, because
      "telling them" means sending mail about a company's data to somebody who
      has left it, which is worse than the confusion it prevents.
    */
    if (!access) return { kind: "drop", userId, why: "no longer a member of this organisation" };

    /*
      Sharing is re-evaluated here too, not only at schedule creation. An author
      who narrows a report from `organisation` to `named` after setting up the
      schedule has revoked access, and a schedule that kept delivering would make
      the revocation cosmetic.
    */
    if (!isSharedWith(report, viewer))
      return { kind: "tell-them-access-changed", userId, why: "this report is no longer shared with you" };

    if (!access.mayUseReports)
      return { kind: "tell-them-access-changed", userId, why: "you no longer have access to reports" };

    if (access.scope === "none")
      return {
        kind: "tell-them-access-changed",
        userId,
        why: "you no longer have access to the records this report is built on",
      };

    return { kind: "send", userId, scopeUsed: access.scope };
  });
}

/**
 * What a recipient is told about the number they are looking at.
 *
 * Ticket 12's second criterion has a consequence nobody writes down: once two
 * viewers legitimately see different totals, a total without its scope is
 * ambiguous. This is the sentence that removes the ambiguity, and it is
 * generated rather than left to whoever writes the email template, because a
 * template is a place this gets forgotten.
 */
export function scopeNote(scope: string): string {
  switch (scope) {
    case "own":
      return "This report covers your own records only.";
    case "team":
      return "This report covers your team's records only.";
    case "all":
      return "This report covers every record in the organisation.";
    default:
      return "This report covers the records you have access to.";
  }
}
