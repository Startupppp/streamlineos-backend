import { z } from "zod";

export const searchMessagesQuerySchema = z
  .object({
    q: z.string().min(1).max(500),
    cursor: z.coerce.number().int().positive().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    sender: z.string().optional(),
  })
  .strict();
export type SearchMessagesQueryInput = z.infer<typeof searchMessagesQuerySchema>;

export const searchQuerySchema = z
  .object({
    q: z.string().min(1).max(500),
  })
  .strict();
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
