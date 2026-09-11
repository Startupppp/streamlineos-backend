import { z } from "zod";

export const hrHubSectionSchema = z.union([
  z.object({ status: z.literal("ok"), data: z.unknown() }),
  z.object({ status: z.literal("error"), code: z.string(), message: z.string() }),
]);

export const hrHubSnapshotSchema = z.object({
  generatedAt: z.string(),
  today: z.string(),
  capabilities: z.record(z.string(), z.boolean()),
  sections: z.record(z.string(), hrHubSectionSchema.nullable()),
});
