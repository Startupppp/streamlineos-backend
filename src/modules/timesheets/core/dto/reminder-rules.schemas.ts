import { wholeDaysBetween } from "../lib/period.helpers";
import { z } from "zod";

/**
 * Reminder rules: a schema, at last.
 *
 * `timesheet_settings.reminder_rules` is a jsonb column that has been writable
 * since it shipped and readable by nothing. The settings DTO declared it
 * `z.unknown().optional()` and `updateSettings` copies every defined field
 * straight through, so any authenticated caller with the settings permission
 * could store arbitrary JSON of arbitrary size there, and no code path ever
 * looked at it. Configuring reminders did nothing; there was nothing to be
 * wrong about because nothing read it.
 *
 * Two consequences shape this file:
 *
 *   1. **Strict on write.** The DTO now parses against this schema, so the
 *      column stops being an open sink. `.strict()` is deliberate: an unknown
 *      key is far more likely to be a typo that silently disables a reminder
 *      than a forward-compatible extension.
 *   2. **Forgiving, and loud, on read.** Rows written before today hold
 *      whatever they hold. The reader must not throw on them — one malformed
 *      row would otherwise take down a sweep across every organisation — so it
 *      reports the row as malformed and treats it as "no rules configured",
 *      which is the safe reading: send nothing rather than guess.
 */

/**
 * Days before the period's due date to send a reminder.
 *
 * Bounded, and bounded small. These are days, and every entry costs one
 * notification per unsubmitted period per organisation per day; an unbounded
 * array here is a way to turn a settings screen into a mail bomb.
 */
const beforeDays = z.array(z.number().int().min(0).max(30)).max(5);
const afterDays = z.array(z.number().int().min(0).max(60)).max(5);

export const reminderRulesSchema = z
  .object({
    enabled: z.boolean(),
    /** Counted back from the due date: period end plus the submission grace. */
    remindBeforeDueDays: beforeDays.default([]),
    /** Counted forward from the same due date — the overdue nudges. */
    remindAfterDueDays: afterDays.default([]),
  })
  .strict();

export type ReminderRules = z.infer<typeof reminderRulesSchema>;

/** What an organisation gets when it has configured nothing: silence. */
export const NO_REMINDERS: ReminderRules = {
  enabled: false,
  remindBeforeDueDays: [],
  remindAfterDueDays: [],
};

export interface ResolvedReminderRules {
  rules: ReminderRules;
  /**
   * True when the stored value existed but did not parse. Distinct from "no
   * rules": one is an organisation that never configured reminders, the other
   * is an organisation whose configuration is being ignored — and the second
   * deserves to be logged and counted, not silently rounded to the first.
   */
  malformed: boolean;
}

/**
 * Reads the stored value without trusting it.
 *
 * Note what this does NOT do: throw. A sweep runs across every organisation,
 * and a single unparseable row must not stop the rest from being reminded.
 */
export function resolveReminderRules(raw: unknown): ResolvedReminderRules {
  if (raw === null || raw === undefined) return { rules: NO_REMINDERS, malformed: false };
  const parsed = reminderRulesSchema.safeParse(raw);
  if (parsed.success) return { rules: parsed.data, malformed: false };
  return { rules: NO_REMINDERS, malformed: true };
}

/**
 * Whether `today` is a day this period should be reminded about, and which kind.
 *
 * All arithmetic is in whole UTC days on `YYYY-MM-DD` strings, because that is
 * what the columns are. Doing it in local time is how a reminder lands a day
 * early for half the world — the repository has been bitten by exactly that
 * before, which is why the tests pin a non-UTC zone.
 */
export type ReminderKind = "DUE_SOON" | "OVERDUE";

export function reminderDue(
  rules: ReminderRules,
  dueDate: string,
  today: string,
): ReminderKind | null {
  if (!rules.enabled) return null;
  const offset = daysBetween(dueDate, today);
  /**
   * Overdue wins a tie at offset 0 only if both lists name it; a period is not
   * "due soon" once the date has passed. Checking before-days first would make
   * `remindBeforeDueDays: [0]` shadow `remindAfterDueDays: [0]`.
   */
  if (offset >= 0 && rules.remindAfterDueDays.includes(offset)) return "OVERDUE";
  if (offset <= 0 && rules.remindBeforeDueDays.includes(-offset)) return "DUE_SOON";
  return null;
}

/**
 * `to - from`, in whole days. Negative when `to` is earlier.
 *
 * Re-exported from `lib/period.helpers` rather than reimplemented: a second
 * copy of date arithmetic is how the two halves of this module came to
 * disagree about what a day is.
 */
export const daysBetween = wholeDaysBetween;

/** Period end plus the org's submission grace, as a `YYYY-MM-DD` string. */
export function dueDateFor(periodEnd: string, graceDays: number | null): string {
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(end)) throw new Error(`not a date: ${periodEnd}`);
  return new Date(end + (graceDays ?? 0) * 86_400_000).toISOString().slice(0, 10);
}
