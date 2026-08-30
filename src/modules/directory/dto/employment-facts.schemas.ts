import { z } from "zod";

export const listEmploymentFactsQuerySchema = z
  .object({
    userIds: z
      .string()
      .min(1)
      .transform((raw) => raw.split(",").map((id) => id.trim()).filter(Boolean))
      .refine((ids) => ids.length > 0, "At least one user id is required")
      .refine((ids) => ids.length <= 100, "At most 100 user ids per request"),
  })
  .strict();

export type ListEmploymentFactsQuery = z.infer<typeof listEmploymentFactsQuerySchema>;
