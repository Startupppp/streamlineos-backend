import { z } from "zod";

export const buildSprintCompletedPayloadSchema = z.object({
  sprintId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  orgId: z.string().min(1),
  name: z.string(),
  actorUserId: z.string().nullable(),
});

export type BuildSprintCompletedPayload = z.infer<
  typeof buildSprintCompletedPayloadSchema
>;
