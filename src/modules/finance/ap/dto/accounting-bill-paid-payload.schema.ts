import { z } from "zod";

export const accountingBillPaidPayloadSchema = z.object({
  organization_id: z.string(),
  bill_id: z.number().int(),
  bill_number: z.string(),
  payment_id: z.number().int(),
  amount_cents: z.number().int(),
  run_id: z.number().int(),
  actor_user_id: z.string(),
});

type AccountingBillPaidPayload = z.infer<typeof accountingBillPaidPayloadSchema>;
