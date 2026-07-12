import { z } from "zod";

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().min(0),
  unitPrice: z.number().min(0),
  taxRate: z.number().min(0).optional(),
});

export const listSchema = z.object({
  status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
  dealId: z.coerce.number().int().positive().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const exportSchema = z.object({
  status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
});

export const createSchema = z.object({
  dealId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
  subject: z.string().min(1),
  description: z.string().optional(),
  currency: z.string().optional(),
  validUntil: z.string(),
  termsAndConditions: z.string().optional(),
  notes: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1),
});

export const updateSchema = z.object({
  subject: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
  validUntil: z.string().optional(),
  termsAndConditions: z.string().optional(),
  notes: z.string().optional(),
  rejectionReason: z.string().optional(),
  lineItems: z.array(lineItemSchema).optional(),
});

export const approveRejectSchema = z.object({
  reason: z.string().optional(),
});
export const markSignedSchema = z.object({
  documentRef: z.string().optional(),
});

export type ListInput = z.infer<typeof listSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
export type ApproveRejectInput = z.infer<typeof approveRejectSchema>;
export type MarkSignedInput = z.infer<typeof markSignedSchema>;
