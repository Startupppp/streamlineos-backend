import { z } from "zod";

const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

const evidenceCitationSchema = z.object({
  path: z.string(),
  label: z.string(),
  value: z.unknown(),
  source: z.literal("payroll_engine"),
});

const payrollAiCapabilitySchema = z.object({
  mode: z.literal("explain_draft_only"),
  autonomousPayrollDecisions: z.literal(false),
  autonomousStatutoryFiling: z.literal(false),
  autonomousPayout: z.literal(false),
  mayRecalculateAmounts: z.literal(false),
  honestyLabel: z.string(),
  note: z.string(),
});

export const payslipExplanationSchema = z.object({
  explanation: z.string(),
  evidenceSnapshot: z.record(z.string(), z.unknown()),
  citations: z.array(evidenceCitationSchema),
  capability: payrollAiCapabilitySchema,
  forbiddenActions: z.array(z.string()),
  aiUsage: aiUsageMetaSchema,
});

export const payrollAiCapabilitiesSchema = z.object({
  mode: z.literal("explain_draft_only"),
  autonomousPayrollDecisions: z.literal(false),
  autonomousStatutoryFiling: z.literal(false),
  autonomousPayout: z.literal(false),
  mayRecalculateAmounts: z.literal(false),
  honestyLabel: z.string(),
  note: z.string(),
  forbiddenActions: z.array(z.string()),
  features: z.array(
    z.object({
      key: z.string(),
      mode: z.string(),
      requiresPublishedPayslip: z.boolean(),
    }),
  ),
});
