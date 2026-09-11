import { z } from "zod";

export const buildReleasePublishedPayloadSchema = z.object({
  releaseId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  orgId: z.string().min(1),
  name: z.string(),
  version: z.string().nullable(),
});

type BuildReleasePublishedPayload = z.infer<
  typeof buildReleasePublishedPayloadSchema
>;
