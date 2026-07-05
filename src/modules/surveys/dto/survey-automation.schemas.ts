import { z } from "zod";

export const createAutomationSchema = z.object({
  eventType: z.enum([
    "survey.published",
    "survey.response.started",
    "survey.response.submitted",
    "survey.assessment.passed",
    "survey.assessment.failed",
    "survey.live.started",
    "survey.live.ended",
    "survey.lead.created",
    "survey.collector.completed_quota",
  ]),
  action: z.object({
    type: z.enum(["create_lead", "update_lead", "webhook", "notify_owner"]),
    scoreThreshold: z.number().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const patchAutomationSchema = createAutomationSchema.partial();

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type PatchAutomationInput = z.infer<typeof patchAutomationSchema>;
