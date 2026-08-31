import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const listSchema = z.object({
  assigneeId: z.string().optional(),
  status: z.enum(["pending", "completed", "cancelled"]).optional(),
  type: z.enum(["CALL", "EMAIL", "MEETING", "CUSTOM"]).optional(),
  entityType: z.enum(["LEAD", "DEAL", "CONTACT", "PROJECT"]).optional(),
  entityId: z.string().optional(),
  limit: pageSizeField(50, 100),
  page: pageNumberField,
});

export const createSchema = z.object({
  title: z.string().min(1).max(255),
  notes: z.string().optional(),
  entityType: z.enum(["LEAD", "DEAL", "CONTACT", "PROJECT"]).optional(),
  entityId: z.number().int().positive().optional(),
  type: z.enum(["CALL", "EMAIL", "MEETING", "CUSTOM"]).default("CUSTOM"),
  assigneeId: z.string().optional(),
  dueDate: z.string().datetime({ offset: true }).optional(),
  remindAt: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().optional(),
});

export const updateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  notes: z.string().optional(),
  type: z.enum(["CALL", "EMAIL", "MEETING", "CUSTOM"]).optional(),
  status: z.enum(["pending", "completed", "cancelled"]).optional(),
  assigneeId: z.string().optional(),
  dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  remindAt: z.string().datetime({ offset: true }).nullable().optional(),
  timezone: z.string().optional(),
});

export const completeSchema = z.object({
  completedAt: z.string().datetime({ offset: true }).optional(),
});

export const analyticsSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const stepSchema = z.object({
  title: z.string().min(1),
  type: z.string().default("CUSTOM"),
  notes: z.string().optional(),
  offsetDays: z.number().int().min(0).default(0),
  order: z.number().int().default(0),
});

export const sequenceListSchema = z.object({
  limit: pageSizeField(100),
});

export const sequenceCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  steps: z.array(stepSchema).min(1),
});

export const sequenceApplySchema = z.object({
  baseDate: z.string().datetime({ offset: true }),
  entityType: z.enum(["LEAD", "DEAL", "CONTACT", "PROJECT"]).optional(),
  entityId: z.number().int().optional(),
  assigneeId: z.string().optional(),
});

export type ListInput = z.infer<typeof listSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
export type CompleteInput = z.infer<typeof completeSchema>;
export type AnalyticsInput = z.infer<typeof analyticsSchema>;
export type SequenceListInput = z.infer<typeof sequenceListSchema>;
export type SequenceCreateInput = z.infer<typeof sequenceCreateSchema>;
export type SequenceApplyInput = z.infer<typeof sequenceApplySchema>;
