import { z } from "zod";

export const manualMethodTypeSchema = z.enum(["bank_transfer", "upi", "cheque", "cash", "other"]);

export const createManualMethodSchema = z.object({
  methodType: manualMethodTypeSchema,
  displayName: z.string().min(1),
  instructions: z.string().optional(),
  bankName: z.string().optional(),
  accountHolder: z.string().optional(),
  maskedAccountNumber: z.string().optional(),
  ifscSwiftIban: z.string().optional(),
  upiId: z.string().optional(),
  paymentReferenceInstructions: z.string().optional(),
  requireManualApproval: z.boolean().default(true),
});
export type CreateManualMethodInput = z.infer<typeof createManualMethodSchema>;

export const updateManualMethodSchema = createManualMethodSchema.partial().omit({ methodType: true });
export type UpdateManualMethodInput = z.infer<typeof updateManualMethodSchema>;
