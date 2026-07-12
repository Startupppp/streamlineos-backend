import { z } from "zod";

export const approvalDecisionSchema = z.object({
  comment: z.string().max(1000).optional(),
});

export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
