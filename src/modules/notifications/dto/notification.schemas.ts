import { z } from "zod";

export const listSchema = z.object({
  unreadOnly: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

export type ListInput = z.infer<typeof listSchema>;
