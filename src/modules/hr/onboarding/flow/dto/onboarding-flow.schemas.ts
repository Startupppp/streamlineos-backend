import { z } from "zod";

export const sessionPatchSchema = z.object({
  currentStep: z.string().min(1).max(120).optional(),
  data: z.record(z.string(), z.any()).optional(),
  completedSteps: z.array(z.string().min(1).max(120)).optional(),
  skippedSteps: z.array(z.string().min(1).max(120)).optional(),
  source: z.string().min(1).max(60).optional(),
}).strict();
export type SessionPatchInput = z.infer<typeof sessionPatchSchema>;

export const orgSetupSkipSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();
export type OrgSetupSkipInput = z.infer<typeof orgSetupSkipSchema>;

export const checklistItemSkipSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();
export type ChecklistItemSkipInput = z.infer<typeof checklistItemSkipSchema>;

export const tourProgressSchema = z.object({
  currentStep: z.number().int().min(0),
}).strict();
export type TourProgressInput = z.infer<typeof tourProgressSchema>;
