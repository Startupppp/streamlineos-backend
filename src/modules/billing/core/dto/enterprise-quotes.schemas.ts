import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createEnterpriseQuoteSchema = z.object({
  subject: z.string().min(1),
  requestedSeats: z.number().int().positive(),
  negotiatedSeats: z.number().int().positive(),
  pricePerSeatInPaise: z.number().int().nonnegative(),
  contractTermMonths: z.union([z.literal(12), z.literal(24), z.literal(36)]),
  contractTerms: z.string().optional(),
  validUntil: z.string().date(),
  notes: z.string().optional(),
  dealId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
});
export type CreateEnterpriseQuoteInput = z.infer<typeof createEnterpriseQuoteSchema>;

export const approveEnterpriseQuoteSchema = z.object({
  notes: z.string().optional(),
});
export type ApproveEnterpriseQuoteInput = z.infer<typeof approveEnterpriseQuoteSchema>;

export const rejectEnterpriseQuoteSchema = z.object({
  reason: z.string().min(1),
});
export type RejectEnterpriseQuoteInput = z.infer<typeof rejectEnterpriseQuoteSchema>;

export const listEnterpriseQuotesSchema = z.object({
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
  page: pageNumberField,
  limit: pageSizeField(20),
});
export type ListEnterpriseQuotesQuery = z.infer<typeof listEnterpriseQuotesSchema>;
