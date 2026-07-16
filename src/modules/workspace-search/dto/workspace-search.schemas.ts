import { z } from "zod";

const ENTITY_TYPES = ["project", "ticket", "lead", "deal", "contact", "client"] as const;

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  entityTypes: z.array(z.enum(ENTITY_TYPES)).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export const askBodySchema = z.object({
  q: z.string().min(1).max(500),
  entityTypes: z.array(z.enum(ENTITY_TYPES)).optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type AskBody = z.infer<typeof askBodySchema>;
export type WorkspaceEntityTypeParam = (typeof ENTITY_TYPES)[number];
