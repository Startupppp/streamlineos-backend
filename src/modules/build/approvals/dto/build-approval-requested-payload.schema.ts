import { z } from "zod";

export const buildApprovalRequestedPayloadSchema = z.object({
  approvalId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  orgId: z.string().min(1),
  approverUserId: z.string().min(1),
  requestedByUserId: z.string().min(1),
  title: z.string().min(1),
});

export type BuildApprovalRequestedPayload = z.infer<
  typeof buildApprovalRequestedPayloadSchema
>;
