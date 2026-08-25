import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createRetentionPolicySchema = z.object({
  recordType: z.enum(["employee", "document", "case", "attendance", "payroll"]),
  retentionMonths: z.number().int().min(1),
  countryCode: z.string().length(2).optional(),
  action: z.enum(["delete", "anonymize"]),
  active: z.boolean().optional(),
});

export const updateRetentionPolicySchema = createRetentionPolicySchema.partial();

export const listRetentionPoliciesSchema = paginationSchema.extend({
  recordType: z.enum(["employee", "document", "case", "attendance", "payroll"]).optional(),
  active: queryBoolean.optional(),
});

export const createDataRequestSchema = z.object({
  subjectUserId: z.string().min(1),
  type: z.enum(["export", "delete", "anonymize"]),
  reason: z.string().max(2000).optional(),
});

export const updateDataRequestSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const listDataRequestsSchema = paginationSchema.extend({
  status: z.enum(["pending", "approved", "processing", "completed", "rejected"]).optional(),
  type: z.enum(["export", "delete", "anonymize"]).optional(),
  subjectUserId: z.string().optional(),
});

export type CreateRetentionPolicyInput = z.infer<typeof createRetentionPolicySchema>;
export type UpdateRetentionPolicyInput = z.infer<typeof updateRetentionPolicySchema>;
export type ListRetentionPoliciesInput = z.infer<typeof listRetentionPoliciesSchema>;
export type CreateDataRequestInput = z.infer<typeof createDataRequestSchema>;
export type UpdateDataRequestInput = z.infer<typeof updateDataRequestSchema>;
export type ListDataRequestsInput = z.infer<typeof listDataRequestsSchema>;
