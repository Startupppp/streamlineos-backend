import { z } from "zod";

/**
 * Closed at the boundary. A bare `z.object({})` strips an unexpected key rather than
 * rejecting it, so a producer that renamed `orgId` would parse clean and hand the consumer
 * a payload with no tenant at all — a dropped field becoming a wrong-subject write instead
 * of an error. Every field here drives a write, so nothing extra may ride along.
 */
export const orgSetupCompletedPayloadSchema = z
  .object({
    orgId: z.string().min(1),
    userId: z.string().min(1),
    moduleKeys: z.array(z.string().min(1)),
    sessionAction: z.enum(["complete", "skip"]),
    skipReason: z.string().nullable(),
    sendWelcome: z.boolean(),
  })
  .strict();

export type OrgSetupCompletedPayload = z.infer<
  typeof orgSetupCompletedPayloadSchema
>;
