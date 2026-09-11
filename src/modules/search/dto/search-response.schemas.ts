import { z } from "zod";

export const globalSearchResultSchema = z.object({
  id: z.number().int(),
  type: z.enum(["lead", "deal", "contact", "client", "ticket"]),
  title: z.string(),
  subtitle: z.string(),
  href: z.string(),
  status: z.string().optional(),
});

export const globalSearchResponseSchema = z.object({
  results: z.array(globalSearchResultSchema),
  total: z.number().int(),
});
