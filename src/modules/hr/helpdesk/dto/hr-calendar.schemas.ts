import { z } from "zod";

export const CALENDAR_EVENT_TYPES = [
  "HOLIDAY",
  "LEAVE",
  "BIRTHDAY",
  "ANNIVERSARY",
  "REVIEW_CYCLE",
  "TRAVEL",
  "INTERVIEW",
] as const;

type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

function isCalendarEventType(value: string): value is CalendarEventType {
  return CALENDAR_EVENT_TYPES.some((type) => type === value);
}

export const hrCalendarSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(isCalendarEventType) : undefined)),
}).strict();

export type HrCalendarInput = z.infer<typeof hrCalendarSchema>;
