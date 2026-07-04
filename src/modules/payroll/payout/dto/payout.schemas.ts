import { z } from "zod";

export const payslipConfigSchema = z.object({
  accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().default("#0f2b7f"),
  showEmployerContributions: z.boolean().optional().default(false),
  showYtd: z.boolean().optional().default(false),
});
export type PayslipTemplateConfig = z.infer<typeof payslipConfigSchema>;

export const approvalActionSchema = z.object({
  comment: z.string().max(1000).optional(),
});
export type ApprovalActionInput = z.infer<typeof approvalActionSchema>;

export const rejectActionSchema = z.object({
  comment: z.string().min(1, "Comment is required on rejection").max(1000),
});
export type RejectActionInput = z.infer<typeof rejectActionSchema>;

export const reopenRunSchema = z.object({
  reason: z.string().min(1, "Reason is required").max(500),
});
export type ReopenRunInput = z.infer<typeof reopenRunSchema>;

export const createBatchSchema = z.object({
  format: z.enum(["NEFT_CSV", "RTGS_CSV"]).optional().default("NEFT_CSV"),
});
export type CreateBatchInput = z.infer<typeof createBatchSchema>;

export const batchesQuerySchema = z.object({
  runId: z.coerce.number().int().positive().optional(),
});
export type BatchesQueryInput = z.infer<typeof batchesQuerySchema>;

export const markItemPaidSchema = z.object({
  transactionRef: z.string().min(1).max(100),
});
export type MarkItemPaidInput = z.infer<typeof markItemPaidSchema>;

export const markItemFailedSchema = z.object({
  failureReason: z.string().min(1).max(500),
});
export type MarkItemFailedInput = z.infer<typeof markItemFailedSchema>;

export const markBatchPaidSchema = z.object({
  transactionRef: z.string().min(1).max(100),
});
export type MarkBatchPaidInput = z.infer<typeof markBatchPaidSchema>;

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  layout: z.enum(["CLASSIC", "MODERN", "COMPLIANCE"]),
  config: payslipConfigSchema,
  isDefault: z.boolean().optional().default(false),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const patchTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  layout: z.enum(["CLASSIC", "MODERN", "COMPLIANCE"]).optional(),
  config: payslipConfigSchema.partial().optional(),
  isDefault: z.boolean().optional(),
});
export type PatchTemplateInput = z.infer<typeof patchTemplateSchema>;

export const previewTemplateSchema = z.object({
  layout: z.enum(["CLASSIC", "MODERN", "COMPLIANCE"]),
  config: payslipConfigSchema,
});
export type PreviewTemplateInput = z.infer<typeof previewTemplateSchema>;

export const publishSchema = z.object({
  userIds: z.array(z.string()).optional(),
});
export type PublishInput = z.infer<typeof publishSchema>;
