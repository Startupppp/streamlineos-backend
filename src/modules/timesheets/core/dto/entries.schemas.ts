import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const entriesQuerySchema = z.object({
  userId: z.string().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  ticketId: z.coerce.number().int().positive().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  billable: z.enum(["true", "false"]).optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
});
export type EntriesQuery = z.infer<typeof entriesQuerySchema>;

export const createEntrySchema = z.object({
  date: dateString,
  hours: z.number().positive(),
  projectId: z.number().int().positive().optional(),
  ticketId: z.number().int().positive().optional(),
  description: z.string().max(2000).optional(),
  isBillable: z.boolean().optional(),
  billingType: z.enum(["BILLABLE", "NON_BILLABLE", "FIXED"]).optional(),
  workLink: z.string().url().max(500).optional(),
  source: z.enum(["MANUAL", "TIMER", "API", "IMPORT"]).optional(),
});
export type CreateEntryInput = z.infer<typeof createEntrySchema>;

export const updateEntrySchema = z.object({
  hours: z.number().positive().optional(),
  description: z.string().max(2000).optional().nullable(),
  isBillable: z.boolean().optional(),
  billingType: z.enum(["BILLABLE", "NON_BILLABLE", "FIXED"]).optional(),
  projectId: z.number().int().positive().optional().nullable(),
  workLink: z.string().url().max(500).optional().nullable(),
});
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;

export const voidEntrySchema = z.object({
  reason: z.string().min(1).max(500),
});
export type VoidEntryInput = z.infer<typeof voidEntrySchema>;
