import { z } from "zod";
import { meetingTypeEnum, meetingStatusEnum, actionItemStatusEnum } from "../../../db/schema";

export const createMeetingSchema = z.object({
  title: z.string().min(1).max(500),
  type: z.enum(meetingTypeEnum.enumValues).optional(),
  status: z.enum(meetingStatusEnum.enumValues).optional(),
  agenda: z.string().optional(),
  notes: z.string().optional(),
  scheduledAt: z.coerce.date().optional(),
  durationMinutes: z.number().int().positive().optional(),
  sprintId: z.number().int().positive().optional(),
});

export const updateMeetingSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  type: z.enum(meetingTypeEnum.enumValues).optional(),
  status: z.enum(meetingStatusEnum.enumValues).optional(),
  agenda: z.string().nullish(),
  notes: z.string().nullish(),
  scheduledAt: z.coerce.date().nullish(),
  durationMinutes: z.number().int().positive().nullish(),
  sprintId: z.number().int().positive().nullish(),
});

export const listMeetingsQuerySchema = z.object({
  status: z.enum(meetingStatusEnum.enumValues).optional(),
  type: z.enum(meetingTypeEnum.enumValues).optional(),
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
