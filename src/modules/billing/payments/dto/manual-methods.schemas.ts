import { z } from "zod";

export const manualMethodTypeSchema = z.enum(["bank_transfer", "upi", "cheque", "cash", "other"]);

export const createManualMethodSchema = z.object({
  methodType: manualMethodTypeSchema,
  displayName: z.string().min(1).max(255),
  instructions: z.string().max(5_000).optional(),
  bankName: z.string().max(255).optional(),
  accountHolder: z.string().max(255).optional(),
  maskedAccountNumber: z.string().max(64).optional(),
  ifscSwiftIban: z.string().max(64).optional(),
  upiId: z.string().max(255).optional(),
  paymentReferenceInstructions: z.string().max(5_000).optional(),
  requireManualApproval: z.boolean().default(true),
}).strict();
export type CreateManualMethodInput = z.infer<typeof createManualMethodSchema>;

export const updateManualMethodSchema = createManualMethodSchema.partial().omit({ methodType: true }).strict();
export type UpdateManualMethodInput = z.infer<typeof updateManualMethodSchema>;
