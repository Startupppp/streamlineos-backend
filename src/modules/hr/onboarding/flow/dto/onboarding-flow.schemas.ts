import { z } from "zod";

import { ONBOARDING_DRAFT_MAX_DEPTH } from "../onboarding-session-privacy";

function exceedsDraftDepth(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (depth > ONBOARDING_DRAFT_MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => exceedsDraftDepth(item, depth + 1));
  return Object.values(value).some((entry) => exceedsDraftDepth(entry, depth + 1));
}

const draftDataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    if (!exceedsDraftDepth(value, 0)) return;
    ctx.addIssue({
      code: "custom",
      message: `Onboarding draft data may not nest deeper than ${ONBOARDING_DRAFT_MAX_DEPTH} levels`,
    });
  });

export const sessionPatchSchema = z.object({
  currentStep: z.string().min(1).max(120).optional(),
  data: draftDataSchema.optional(),
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
