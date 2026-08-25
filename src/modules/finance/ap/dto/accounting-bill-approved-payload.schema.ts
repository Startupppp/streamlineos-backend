import { z } from "zod";

export const accountingBillApprovedPayloadSchema = z.object({
  organization_id: z.string().min(1),
  bill_id: z.number().int().positive(),
  bill_number: z.string(),
  total_cents: z.number().int(),
  actor_user_id: z.string().min(1),
});

export type AccountingBillApprovedPayload = z.infer<
  typeof accountingBillApprovedPayloadSchema
>;
