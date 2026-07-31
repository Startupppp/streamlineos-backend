import { z } from "zod";
import { meetingTypeEnum, projectMeetingStatusEnum, actionItemStatusEnum } from "../../../../db/schema";

const SYMBOL_ONLY_RE = /^[^a-zA-Z0-9]+$/;

const meetingTitleSchema = z
  .string()
  .min(1, "Title is required")
  .max(200, "Title must be 200 characters or fewer")
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, "Title cannot be blank or whitespace only")
  .refine((v) => !SYMBOL_ONLY_RE.test(v), "Title must contain at least one letter or number");

const meetingTitleUpdateSchema = z
  .string()
  .min(1, "Title is required")
  .max(200, "Title must be 200 characters or fewer")
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, "Title cannot be blank or whitespace only")
  .refine((v) => !SYMBOL_ONLY_RE.test(v), "Title must contain at least one letter or number")
  .optional();

export const recurrenceRuleSchema = z.object({
  frequency: z.enum(["daily", "weekly", "biweekly", "custom"]),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  endDate: z.string().optional(),
  occurrences: z.number().int().positive().optional(),
});

export const createMeetingSchema = z
  .object({
    title: meetingTitleSchema,
    type: z.enum(meetingTypeEnum.enumValues).optional(),
    status: z.enum(projectMeetingStatusEnum.enumValues).optional(),
    agenda: z.string().optional(),
    notes: z.string().optional(),
    scheduledAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional(),
    durationMinutes: z.number().int().positive().optional(),
    sprintId: z.number().int().positive().optional(),
    attendeeUserIds: z.array(z.string().min(1)).optional(),
    recurrenceRule: recurrenceRuleSchema.optional(),
    timezone: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.scheduledAt && data.endAt) return data.endAt > data.scheduledAt;
      return true;
    },
    { message: "End time must be after start time", path: ["endAt"] },
  );

export const updateMeetingSchema = z
  .object({
    title: meetingTitleUpdateSchema,
    type: z.enum(meetingTypeEnum.enumValues).optional(),
    status: z.enum(projectMeetingStatusEnum.enumValues).optional(),
    agenda: z.string().nullish(),
    notes: z.string().nullish(),
    scheduledAt: z.coerce.date().nullish(),
    endAt: z.coerce.date().nullish(),
    durationMinutes: z.number().int().positive().nullish(),
    sprintId: z.number().int().positive().nullish(),
    recurrenceRule: recurrenceRuleSchema.nullish(),
    timezone: z.string().nullish(),
  })
  .refine(
    (data) => {
      if (data.scheduledAt && data.endAt) return data.endAt > data.scheduledAt;
      return true;
    },
    { message: "End time must be after start time", path: ["endAt"] },
  );

export const listMeetingsQuerySchema = z.object({
  status: z.enum(projectMeetingStatusEnum.enumValues).optional(),
  type: z.enum(meetingTypeEnum.enumValues).optional(),
  dateFilter: z.enum(["today", "this_week", "upcoming", "past"]).optional(),
  hostId: z.string().optional(),
  attendeeId: z.string().optional(),
  hasActionItems: z.coerce.boolean().optional(),
  hasUnresolvedActionItems: z.coerce.boolean().optional(),
});

export const addAttendeeSchema = z.object({
  userId: z.string().min(1),
});

export const upsertStandupSchema = z.object({
  yesterday: z.string().optional(),
  today: z.string().optional(),
  blockers: z.string().optional(),
});

export const createActionItemSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  assigneeId: z.string().min(1).optional(),
  dueDate: z.coerce.date().optional(),
});

export const updateActionItemSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  assigneeId: z.string().min(1).nullish(),
  dueDate: z.coerce.date().nullish(),
  status: z.enum(actionItemStatusEnum.enumValues).optional(),
});

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;
export type ListMeetingsQuery = z.infer<typeof listMeetingsQuerySchema>;
export type AddAttendeeInput = z.infer<typeof addAttendeeSchema>;
export type UpsertStandupInput = z.infer<typeof upsertStandupSchema>;
export type CreateActionItemInput = z.infer<typeof createActionItemSchema>;
export type UpdateActionItemInput = z.infer<typeof updateActionItemSchema>;
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;
