import { z } from "zod";

export const onboardingFlowTypeSchema = z.enum([
  "org_setup",
  "member_setup",
  "employee_onboarding",
  "module_setup",
  "guided_tour",
  "payment_setup",
]);

export const sessionPatchSchema = z.object({
  currentStep: z.string().min(1).max(120).optional(),
  data: z.record(z.string(), z.any()).optional(),
  completedSteps: z.array(z.string().min(1).max(120)).optional(),
  skippedSteps: z.array(z.string().min(1).max(120)).optional(),
  source: z.string().min(1).max(60).optional(),
});
export type SessionPatchInput = z.infer<typeof sessionPatchSchema>;

export const orgSetupSkipSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type OrgSetupSkipInput = z.infer<typeof orgSetupSkipSchema>;

export const checklistItemSkipSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type ChecklistItemSkipInput = z.infer<typeof checklistItemSkipSchema>;

export const tourProgressSchema = z.object({
  currentStep: z.number().int().min(0),
});
export type TourProgressInput = z.infer<typeof tourProgressSchema>;
