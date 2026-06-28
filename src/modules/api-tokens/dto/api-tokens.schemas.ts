import { z } from "zod";

export const createApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  scopes: z.array(z.string().min(1)).default([]),
  expiresAt: z.coerce.date().optional(),
});

export const listApiTokensSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
export type ListApiTokensQuery = z.infer<typeof listApiTokensSchema>;
