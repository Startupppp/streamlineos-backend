import { z } from "zod";

export const HR_POLICY_TYPES = [
  "leave",
  "attendance",
  "shift_roster",
  "overtime",
  "comp_off",
  "probation",
  "notice_period",
  "document_requirement",
  "approval",
  "expense",
  "travel",
  "asset",
  "wfh",
  "remote_work",
  "payroll_eligibility",
] as const;

export const HR_POLICY_STATUSES = ["draft", "active", "archived"] as const;

export const HR_SCOPE_TYPES = [
  "organization",
  "country",
  "state",
  "location",
  "department",
  "team",
  "role",
  "job_level",
  "employment_type",
  "employee",
] as const;

export const policiesListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(HR_POLICY_TYPES).optional(),
  status: z.enum(HR_POLICY_STATUSES).optional(),
  search: z.string().optional(),
});

export type PoliciesListQuery = z.infer<typeof policiesListQuerySchema>;

export const policyScopeSchema = z.object({
  scopeType: z.enum(HR_SCOPE_TYPES),
  scopeValue: z.string().min(1),
});

export const createPolicySchema = z.object({
  policyType: z.enum(HR_POLICY_TYPES),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  priority: z.number().int().min(0).max(9999).default(0),
  rules: z.record(z.string(), z.unknown()),
  scopes: z.array(policyScopeSchema).min(1),
});

export type CreatePolicyInput = z.infer<typeof createPolicySchema>;

export const updatePolicySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  rules: z.record(z.string(), z.unknown()).optional(),
  scopes: z.array(policyScopeSchema).optional(),
});

export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

export const previewQuerySchema = z.object({
  employeeId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type PreviewQuery = z.infer<typeof previewQuerySchema>;
