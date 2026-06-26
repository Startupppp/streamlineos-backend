import { z } from "zod";

const triggerEnum = z.enum([
  "STAGE_CHANGED",
  "INTERVIEW_RESULT_SET",
  "SLA_BREACHED",
  "OFFER_SENT",
  "OFFER_ACCEPTED",
  "OFFER_REJECTED",
  "SCORECARD_SUBMITTED",
]);

const actionEnum = z.enum([
  "SEND_EMAIL",
  "MOVE_TO_STAGE",
  "CREATE_INTERVIEW",
  "SEND_NOTIFICATION",
  "NOTIFY_HIRING_MANAGER",
]);

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  trigger: triggerEnum,
  triggerConditions: z.record(z.string(), z.unknown()).optional().default({}),
  action: actionEnum,
  actionPayload: z.record(z.string(), z.unknown()).optional().default({}),
  isActive: z.boolean().optional().default(true),
});
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  isActive: z.boolean().optional(),
  triggerConditions: z.record(z.string(), z.unknown()).optional(),
  action: actionEnum.optional(),
  actionPayload: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

const sequenceStepSchema = z.object({
  stepOrder: z.number().int().min(0),
  delayDays: z.number().int().min(0).default(0),
  subject: z.string().min(1).max(500).trim(),
  htmlBody: z.string().min(1),
});

const triggerTypeEnum = z.enum([
  "MANUAL",
  "CANDIDATE_ADDED",
  "APPLICATION_RECEIVED",
  "STAGE_CHANGED",
  "OFFER_SENT",
]);

export const createSequenceSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional().default(true),
  triggerType: triggerTypeEnum.default("MANUAL"),
  targetAudience: z.record(z.string(), z.unknown()).optional().default({}),
  steps: z.array(sequenceStepSchema).optional().default([]),
});
export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;

export const updateSequenceSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
  triggerType: triggerTypeEnum.optional(),
  targetAudience: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(sequenceStepSchema).optional(),
});
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;

export const enrollSequenceSchema = z.object({
  candidateIds: z.array(z.number().int().positive()).min(1).max(100),
});
export type EnrollSequenceInput = z.infer<typeof enrollSequenceSchema>;
