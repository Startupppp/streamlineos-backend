import { z } from "zod";

/**
 * The web calendar fetches three whole months (previous, current, next), whose
 * widest real span is exactly 92.000 days — Feb 29 2024 through May 31 2024.
 * A 92-day limit therefore sits on the boundary with no margin, and one day of
 * padding or one timezone shift would 400 the calendar for everyone. The limit
 * exists to stop UNBOUNDED ranges, not to shave the last month, so it carries
 * headroom. `calendar-span.spec.ts` derives the client's worst case and fails
 * if this drops back under it.
 */
export const CALENDAR_MAX_SPAN_DAYS = 120;
export const CALENDAR_EVENTS_CAP = 2000;

const ianaTimezone = z.string().refine(
  (tz) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  "Must be a valid IANA timezone name",
);

const titleSchema = z
  .string()
  .min(2, "Event title must be at least 2 characters")
  .max(100, "Event title must be at most 100 characters")
  .refine(
    (v) => /^[a-zA-Z0-9]/.test(v.trim()),
    "Event title must start with a letter or number",
  )
  .refine(
    (v) => !/\s{2,}/.test(v),
    "Event title cannot have consecutive spaces",
  );

const parseableDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Invalid date format");

export const listEventsSchema = z
  .object({
    start: parseableDate,
    end: parseableDate,
  })
  .refine(
    (v) => new Date(v.end) > new Date(v.start),
    { message: "end must be after start", path: ["end"] },
  )
  .refine(
    (v) => {
      const diffMs = new Date(v.end).getTime() - new Date(v.start).getTime();
      return diffMs / (1000 * 60 * 60 * 24) <= CALENDAR_MAX_SPAN_DAYS;
    },
    {
      message: `Date range may not exceed ${CALENDAR_MAX_SPAN_DAYS} days`,
      path: ["end"],
    },
  );

export const createEventSchema = z
  .object({
    title: titleSchema,
    description: z.string().optional(),
    location: z.string().optional(),
    startDate: z.string(),
    endDate: z.string(),
    timezone: ianaTimezone,
    allDay: z.boolean().optional(),
    color: z.string().optional(),
    category: z.string().default("general"),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    attendeeIds: z.array(z.string()).optional(),
    agenda: z.string().optional(),
    linkedDealId: z.number().int().optional(),
    linkedLeadId: z.number().int().optional(),
    syncConnectionId: z.number().int().positive().optional(),
    addConference: z.boolean().optional(),
  })
  .refine(
    (v) => {
      const start = new Date(v.startDate);
      const end = new Date(v.endDate);
      return (
        !Number.isNaN(start.getTime()) &&
        !Number.isNaN(end.getTime()) &&
        end > start
      );
    },
    { message: "End date must be after start date", path: ["endDate"] },
  );

export const updateEventSchema = z.object({
  title: titleSchema.optional(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  timezone: ianaTimezone.optional(),
  allDay: z.boolean().optional(),
  color: z.string().nullable().optional(),
  category: z.string().optional(),
  entityType: z.string().nullable().optional(),
  entityId: z.string().nullable().optional(),
  attendeeIds: z.array(z.string()).optional(),
  agenda: z.string().nullable().optional(),
  postMeetingNotes: z.string().nullable().optional(),
  linkedDealId: z.number().int().nullable().optional(),
  linkedLeadId: z.number().int().nullable().optional(),
});

export const rsvpSchema = z.object({
  status: z.enum(["accepted", "declined", "tentative"]),
});

export const exportSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const externalEventsQuerySchema = z.object({
  start: parseableDate,
  end: parseableDate,
});

export type ListEventsInput = z.infer<typeof listEventsSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type RsvpInput = z.infer<typeof rsvpSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
export type ExternalEventsQueryInput = z.infer<
  typeof externalEventsQuerySchema
>;
