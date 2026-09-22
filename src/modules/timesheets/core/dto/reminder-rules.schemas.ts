import { wholeDaysBetween } from "../lib/period.helpers";
import { z } from "zod";

const beforeDays = z.array(z.number().int().min(0).max(30)).max(5);
const afterDays = z.array(z.number().int().min(0).max(60)).max(5);

export const reminderRulesSchema = z
  .object({
    enabled: z.boolean(),
    remindBeforeDueDays: beforeDays.default([]),
    remindAfterDueDays: afterDays.default([]),
  })
  .strict();

export type ReminderRules = z.infer<typeof reminderRulesSchema>;

export const NO_REMINDERS: ReminderRules = {
  enabled: false,
  remindBeforeDueDays: [],
  remindAfterDueDays: [],
};

export interface ResolvedReminderRules {
  rules: ReminderRules;
  malformed: boolean;
}

export function resolveReminderRules(raw: unknown): ResolvedReminderRules {
  if (raw === null || raw === undefined) return { rules: NO_REMINDERS, malformed: false };
  const parsed = reminderRulesSchema.safeParse(raw);
  if (parsed.success) return { rules: parsed.data, malformed: false };
  return { rules: NO_REMINDERS, malformed: true };
}

export type ReminderKind = "DUE_SOON" | "OVERDUE";

export function reminderDue(
  rules: ReminderRules,
  dueDate: string,
  today: string,
): ReminderKind | null {
  if (!rules.enabled) return null;
  const offset = daysBetween(dueDate, today);
  if (offset >= 0 && rules.remindAfterDueDays.includes(offset)) return "OVERDUE";
  if (offset <= 0 && rules.remindBeforeDueDays.includes(-offset)) return "DUE_SOON";
  return null;
}

export const daysBetween = wholeDaysBetween;

export function dueDateFor(periodEnd: string, graceDays: number | null): string {
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(end)) throw new Error(`not a date: ${periodEnd}`);
  return new Date(end + (graceDays ?? 0) * 86_400_000).toISOString().slice(0, 10);
}
