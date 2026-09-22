import { z } from "zod";
import {
  timesheetBillingTypeSchema,
  timesheetEntrySourceSchema,
  timesheetEntryStatusSchema,
} from "./status.schemas";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const entriesQuerySchema = z.object({
  userId: z.string().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  ticketId: z.coerce.number().int().positive().optional(),
  status: timesheetEntryStatusSchema.optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  billable: z.enum(["true", "false"]).optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
}).strict();
export type EntriesQuery = z.infer<typeof entriesQuerySchema>;

export const createEntrySchema = z.object({
  date: dateString,
  hours: z.number().positive(),
  projectId: z.number().int().positive().optional(),
  ticketId: z.number().int().positive().optional(),
  description: z.string().max(2000).optional(),
  isBillable: z.boolean().optional(),
  billingType: timesheetBillingTypeSchema.optional(),
  workLink: z.string().url().max(500).optional(),
  source: timesheetEntrySourceSchema.optional(),
}).strict();
export type CreateEntryInput = z.infer<typeof createEntrySchema>;

export const updateEntrySchema = z.object({
  hours: z.number().positive().optional(),
  description: z.string().max(2000).optional().nullable(),
  isBillable: z.boolean().optional(),
  billingType: timesheetBillingTypeSchema.optional(),
  projectId: z.number().int().positive().optional().nullable(),
  workLink: z.string().url().max(500).optional().nullable(),
}).strict();
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;

export const voidEntrySchema = z.object({
  reason: z.string().min(1).max(500),
}).strict();
export type VoidEntryInput = z.infer<typeof voidEntrySchema>;

export const draftFromAttendanceSchema = z
  .object({
    start: dateString,
    end: dateString,
  })
  .strict();
export type DraftFromAttendanceInput = z.infer<typeof draftFromAttendanceSchema>;
