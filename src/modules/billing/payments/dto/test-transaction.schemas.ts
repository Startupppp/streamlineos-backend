import { z } from "zod";

export const createTestTransactionSchema = z.object({
  amount: z.string().max(12).regex(/^\d+(\.\d{1,2})?$/, "amount must be a decimal string, e.g. \"499.00\""),
  currency: z.string().length(3).default("INR"),
}).strict();
export type CreateTestTransactionInput = z.infer<typeof createTestTransactionSchema>;

export const verifyTestTransactionSchema = z.object({
  providerPaymentId: z.string().min(1).max(255),
  signature: z.string().min(1).max(512),
}).strict();
export type VerifyTestTransactionInput = z.infer<typeof verifyTestTransactionSchema>;
