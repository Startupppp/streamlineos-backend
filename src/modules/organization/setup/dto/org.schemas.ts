import { z } from "zod";

export const ORG_MODULE_KEYS = [
  "hr",
  "crm",
  "build",
  "accounting",
  "inventory",
  "kb",
  "chat",
  "support",
  "surveys",
  "payroll",
  "sign",
  "timesheets",
] as const;

export const setupSchema = z.object({
  companyName: z.string().max(200).optional(),
  industry: z.string().min(1, "Industry is required").max(100),
  companySize: z.string().min(1, "Company size is required").max(50),
  country: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  phone: z.string().max(32).optional(),
  enabledModules: z
    .array(z.enum(ORG_MODULE_KEYS))
    .min(1, "At least one module is required")
    .max(50),
});

export type SetupInput = z.infer<typeof setupSchema>;

export const listOrgMembersQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListOrgMembersQueryInput = z.infer<typeof listOrgMembersQuerySchema>;
