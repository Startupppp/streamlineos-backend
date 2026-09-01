import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const createProxySchema = z.object({
  proxyUserId: z.string().min(1),
  scope: z.enum(["approvals", "hr_admin", "manager_tasks"]),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  reason: z.string().max(1000).optional(),
  disallowSensitive: z.boolean().optional(),
});

export const updateProxySchema = createProxySchema.partial();

export const listProxiesSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  scope: z.enum(["approvals", "hr_admin", "manager_tasks"]).optional(),
  active: queryBoolean.optional(),
});

export type CreateProxyInput = z.infer<typeof createProxySchema>;
export type UpdateProxyInput = z.infer<typeof updateProxySchema>;
export type ListProxiesInput = z.infer<typeof listProxiesSchema>;
