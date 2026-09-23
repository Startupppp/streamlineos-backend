import { z } from "zod";
import { INVOICEABLE_ENTRY_CAP } from "../timesheet-invoicing.service";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const uninvoicedQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  projectId: z.coerce.number().int().positive().optional(),
}).strict();
export type UninvoicedQuery = z.infer<typeof uninvoicedQuerySchema>;

export const uninvoicedEntriesQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  projectId: z.coerce.number().int().positive().optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(INVOICEABLE_ENTRY_CAP)
    .default(INVOICEABLE_ENTRY_CAP),
}).strict();
export type UninvoicedEntriesQuery = z.infer<typeof uninvoicedEntriesQuerySchema>;

export const exportBillingSchema = z.object({
  startDate: dateString,
  endDate: dateString,
  format: z.enum(["CSV", "XLSX"]),
  projectId: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();
export type ExportBillingInput = z.infer<typeof exportBillingSchema>;

export const createInvoiceDraftSchema = z.object({
  startDate: dateString,
  endDate: dateString,
  projectId: z.number().int().positive().optional(),
}).strict();
export type CreateInvoiceDraftInput = z.infer<typeof createInvoiceDraftSchema>;

export const ratePreviewQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  userId: z.string().optional(),
  ticketId: z.coerce.number().int().positive().optional(),
  clientId: z.coerce.number().int().positive().optional(),
  date: dateString.optional(),
}).strict();
export type RatePreviewQuery = z.infer<typeof ratePreviewQuerySchema>;

export const billingExportSnapshotSchema = z.array(
  z.object({ computedAmount: z.number().optional() }).passthrough(),
);
export type BillingExportSnapshot = z.infer<typeof billingExportSnapshotSchema>;
