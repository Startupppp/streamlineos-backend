import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createProxySchema = z.object({
  proxyUserId: z.string().min(1),
  scope: z.enum(["approvals", "hr_admin", "manager_tasks"]),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  reason: z.string().max(1000).optional(),
  disallowSensitive: z.boolean().optional(),
});

export const updateProxySchema = createProxySchema.partial();

export const listProxiesSchema = paginationSchema.extend({
  scope: z.enum(["approvals", "hr_admin", "manager_tasks"]).optional(),
  active: z.coerce.boolean().optional(),
});

export type CreateProxyInput = z.infer<typeof createProxySchema>;
export type UpdateProxyInput = z.infer<typeof updateProxySchema>;
export type ListProxiesInput = z.infer<typeof listProxiesSchema>;
