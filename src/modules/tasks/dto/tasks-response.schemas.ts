import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const taskRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.number().int().nullable(),
  type: z.string(),
  status: z.string(),
  snoozedUntil: nullableWireDate(),
  assigneeId: z.string().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  dueDate: nullableWireDate(),
  remindAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  timezone: z.string().nullable(),
  recurrence: z.record(z.string(), z.unknown()).nullable(),
  parentTaskId: z.number().int().nullable(),
  isTemplate: z.boolean(),
  templateName: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const tasksListResponseSchema = z.object({
  tasks: z.array(taskRowSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const perRepAnalyticsSchema = z.object({
  assigneeId: z.string().nullable(),
  name: z.string(),
  total: z.number().int(),
  completed: z.number().int(),
  overdue: z.number().int(),
  completionRate: z.number().int(),
});

export const taskAnalyticsSchema = z.object({
  period: z.number().int(),
  total: z.number().int(),
  completed: z.number().int(),
  overdue: z.number().int(),
  completionRate: z.number().int(),
  perRep: z.array(perRepAnalyticsSchema),
});

const sequenceStepSchema = z.object({
  id: z.number().int(),
  sequenceId: z.number().int(),
  title: z.string(),
  type: z.string(),
  notes: z.string().nullable(),
  offsetDays: z.number().int(),
  order: z.number().int(),
});

export const taskSequenceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  steps: z.array(sequenceStepSchema).optional(),
});

export const taskSequencesListSchema = z.array(taskSequenceRowSchema);

export const taskSequenceSuccessSchema = z.object({ success: z.literal(true) });

export const taskSequenceApplySchema = z.object({
  created: z.array(taskRowSchema),
  count: z.number().int(),
});

export const taskSuccessSchema = z.object({ success: z.literal(true) });
