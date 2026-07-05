import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const uninvoicedQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  projectId: z.coerce.number().int().positive().optional(),
});
export type UninvoicedQuery = z.infer<typeof uninvoicedQuerySchema>;

export const exportBillingSchema = z.object({
  startDate: dateString,
  endDate: dateString,
  format: z.enum(["CSV", "XLSX"]),
  projectId: z.number().int().positive().optional(),
});
export type ExportBillingInput = z.infer<typeof exportBillingSchema>;

export const createInvoiceDraftSchema = z.object({
  startDate: dateString,
  endDate: dateString,
  projectId: z.number().int().positive().optional(),
});
export type CreateInvoiceDraftInput = z.infer<typeof createInvoiceDraftSchema>;

export const ratePreviewQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  userId: z.string().optional(),
  ticketId: z.coerce.number().int().positive().optional(),
});
export type RatePreviewQuery = z.infer<typeof ratePreviewQuerySchema>;
