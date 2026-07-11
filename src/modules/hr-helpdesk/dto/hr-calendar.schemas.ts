import { z } from "zod";

export const CALENDAR_EVENT_TYPES = [
  "HOLIDAY",
  "LEAVE",
  "BIRTHDAY",
  "ANNIVERSARY",
  "REVIEW_CYCLE",
  "TRAINING",
  "TRAVEL",
  "INTERVIEW",
] as const;

export const hrCalendarSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? (v.split(",").filter((t) => CALENDAR_EVENT_TYPES.includes(t as typeof CALENDAR_EVENT_TYPES[number])) as (typeof CALENDAR_EVENT_TYPES)[number][]) : undefined)),
});

export type HrCalendarInput = z.infer<typeof hrCalendarSchema>;
