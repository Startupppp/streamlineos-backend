import { z } from "zod";

export const cronSkippedSchema = z.object({
  success: z.literal(true),
  skipped: z.literal(true),
  message: z.string(),
});
