import { z } from "zod";

const titleSchema = z
  .string()
  .min(2, "Event title must be at least 2 characters")
  .max(100, "Event title must be at most 100 characters")
  .refine((v) => /^[a-zA-Z0-9]/.test(v.trim()), "Event title must start with a letter or number")
  .refine((v) => !/\s{2,}/.test(v), "Event title cannot have consecutive spaces");

export const listEventsSchema = z.object({
  start: z.string(),
  end: z.string(),
});

export const createEventSchema = z
  .object({
    title: titleSchema,
    description: z.string().optional(),
    location: z.string().optional(),
    startDate: z.string(),
    endDate: z.string(),
    allDay: z.boolean().optional(),
    color: z.string().optional(),
    category: z.string().default("general"),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    attendeeIds: z.array(z.string()).optional(),
    isRecurring: z.boolean().optional(),
    recurringRule: z.string().optional(),
    agenda: z.string().optional(),
    linkedDealId: z.number().int().optional(),
    linkedLeadId: z.number().int().optional(),
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
  allDay: z.boolean().optional(),
  color: z.string().nullable().optional(),
  category: z.string().optional(),
  entityType: z.string().nullable().optional(),
  entityId: z.string().nullable().optional(),
  attendeeIds: z.array(z.string()).optional(),
  isRecurring: z.boolean().optional(),
  recurringRule: z.string().nullable().optional(),
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

export type ListEventsInput = z.infer<typeof listEventsSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type RsvpInput = z.infer<typeof rsvpSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
