import { z } from "zod";

export const gdprRectificationBodySchema = z
  .object({
    field: z.literal("profile.name"),
    value: z.string().trim().min(1).max(200),
  })
  .strict();

export type GdprRectificationBody = z.infer<typeof gdprRectificationBodySchema>;
