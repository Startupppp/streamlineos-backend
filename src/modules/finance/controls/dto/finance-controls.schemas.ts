import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createApprovalPolicySchema = z.object({
  recordType: z.enum([
    "MANUAL_JOURNAL",
    "PURCHASE_BILL",
    "VENDOR_PAYMENT",
    "EXPENSE",
    "CREDIT_NOTE",
    "PERIOD_REOPEN",
    "BANK_ADJUSTMENT",
  ]),
  minAmount: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable().optional(),
  approverRole: z.string().max(100).nullable().optional(),
  approverUserId: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
}).strict();

export const updateApprovalPolicySchema = createApprovalPolicySchema.partial().strict();

export const listApprovalsSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  recordType: z
    .enum([
      "MANUAL_JOURNAL",
      "PURCHASE_BILL",
      "VENDOR_PAYMENT",
      "EXPENSE",
      "CREDIT_NOTE",
      "PERIOD_REOPEN",
      "BANK_ADJUSTMENT",
    ])
    .optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export const approvalDecisionSchema = z.object({
  comment: z.string().max(1000).optional(),
}).strict();

export const listAuditSchema = z.object({
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  action: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export const upsertExchangeRateSchema = z.object({
  fromCurrency: z.string().length(3).toUpperCase(),
  toCurrency: z.string().length(3).toUpperCase(),
  rate: z.string().regex(/^\d+(\.\d{1,8})?$/),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const listExchangeRatesSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
}).strict();

export type CreateApprovalPolicyInput = z.infer<typeof createApprovalPolicySchema>;
export type UpdateApprovalPolicyInput = z.infer<typeof updateApprovalPolicySchema>;
export type ListApprovalsQuery = z.infer<typeof listApprovalsSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type ListAuditQuery = z.infer<typeof listAuditSchema>;
export type UpsertExchangeRateInput = z.infer<typeof upsertExchangeRateSchema>;
export type ListExchangeRatesQuery = z.infer<typeof listExchangeRatesSchema>;

export const listPoliciesSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
});
export type ListPoliciesQuery = z.infer<typeof listPoliciesSchema>;
