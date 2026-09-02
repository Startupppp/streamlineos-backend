import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createEnterpriseQuoteSchema = z.object({
  subject: z.string().min(1).max(255),
  requestedSeats: z.number().int().positive().max(1_000_000),
  negotiatedSeats: z.number().int().positive().max(1_000_000),
  pricePerSeatInPaise: z.number().int().nonnegative().max(100_000_000),
  contractTermMonths: z.union([z.literal(12), z.literal(24), z.literal(36)]),
  contractTerms: z.string().max(10_000).optional(),
  validUntil: z.string().date(),
  notes: z.string().max(10_000).optional(),
  dealId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
}).strict();
export type CreateEnterpriseQuoteInput = z.infer<typeof createEnterpriseQuoteSchema>;

export const approveEnterpriseQuoteSchema = z.object({
  notes: z.string().max(10_000).optional(),
}).strict();
export type ApproveEnterpriseQuoteInput = z.infer<typeof approveEnterpriseQuoteSchema>;

export const rejectEnterpriseQuoteSchema = z.object({
  reason: z.string().min(1).max(10_000),
}).strict();
export type RejectEnterpriseQuoteInput = z.infer<typeof rejectEnterpriseQuoteSchema>;

export const listEnterpriseQuotesSchema = z.object({
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(20),
}).strict();
export type ListEnterpriseQuotesQuery = z.infer<typeof listEnterpriseQuotesSchema>;
