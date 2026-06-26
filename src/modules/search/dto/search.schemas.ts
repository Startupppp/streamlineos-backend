import { z } from "zod";

export const searchQuerySchema = z.object({
  q: z.string().min(2, "Query must be at least 2 characters"),
  limit: z.coerce.number().min(1).max(20).optional(),
});

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
