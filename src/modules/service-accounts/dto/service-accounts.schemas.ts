import { z } from "zod";

export const createServiceAccountSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).default([]),
}).strict();

export const updateServiceAccountSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  permissions: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const listServiceAccountsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export type CreateServiceAccountInput = z.infer<typeof createServiceAccountSchema>;
export type UpdateServiceAccountInput = z.infer<typeof updateServiceAccountSchema>;
export type ListServiceAccountsQuery = z.infer<typeof listServiceAccountsSchema>;
