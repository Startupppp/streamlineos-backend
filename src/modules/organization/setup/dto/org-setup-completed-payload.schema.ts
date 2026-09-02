import { z } from "zod";

export const orgSetupCompletedPayloadSchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  moduleKeys: z.array(z.string().min(1)),
  sessionAction: z.enum(["complete", "skip"]),
  skipReason: z.string().nullable(),
  sendWelcome: z.boolean(),
});

export type OrgSetupCompletedPayload = z.infer<
  typeof orgSetupCompletedPayloadSchema
>;
