import { z } from "zod";

export const listInvoicesSchema = z.object({
  status: z.enum(["DRAFT", "ISSUED", "PAID", "FAILED", "VOIDED"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;
