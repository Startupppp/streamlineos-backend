import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createBankTransferSchema = z.object({
  fromBankAccountId: z.number().int().positive(),
  toBankAccountId: z.number().int().positive(),
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/).refine((v) => parseFloat(v) > 0, { message: "amount must be positive" }),
  transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
}).strict().refine((d) => d.fromBankAccountId !== d.toBankAccountId, {
  message: "fromBankAccountId and toBankAccountId must differ",
});

export const transfersQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  bankAccountId: z.coerce.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export type CreateBankTransferInput = z.infer<typeof createBankTransferSchema>;
export type TransfersQuery = z.infer<typeof transfersQuerySchema>;
