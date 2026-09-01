import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const createRetentionPolicySchema = z.object({
  recordType: z.enum(["employee", "document", "case", "attendance", "payroll"]),
  retentionMonths: z.number().int().min(1),
  countryCode: z.string().length(2).optional(),
  action: z.enum(["delete", "anonymize"]),
  active: z.boolean().optional(),
});

export const updateRetentionPolicySchema = createRetentionPolicySchema.partial();

export const listRetentionPoliciesSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  recordType: z.enum(["employee", "document", "case", "attendance", "payroll"]).optional(),
  active: queryBoolean.optional(),
});

export const createDataRequestSchema = z.object({
  subjectUserId: z.string().min(1),
  type: z.enum(["export", "delete", "anonymize", "correction"]),
  reason: z.string().max(2000).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "correction" && !value.reason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "A correction request must describe the field and corrected value",
    });
  }
});

export const updateDataRequestSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const listDataRequestsSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  status: z.enum(["pending", "approved", "processing", "completed", "rejected"]).optional(),
  type: z.enum(["export", "delete", "anonymize", "correction"]).optional(),
  subjectUserId: z.string().optional(),
});

export type CreateRetentionPolicyInput = z.infer<typeof createRetentionPolicySchema>;
export type UpdateRetentionPolicyInput = z.infer<typeof updateRetentionPolicySchema>;
export type ListRetentionPoliciesInput = z.infer<typeof listRetentionPoliciesSchema>;
export type CreateDataRequestInput = z.infer<typeof createDataRequestSchema>;
export type UpdateDataRequestInput = z.infer<typeof updateDataRequestSchema>;
export type ListDataRequestsInput = z.infer<typeof listDataRequestsSchema>;
