import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

export const signSettingsResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  defaultExpirationDays: z.number().int(),
  expirationWarningDays: z.number().int(),
  defaultReminderFirstAfterDays: z.number().int(),
  defaultReminderRepeatDays: z.number().int(),
  defaultReminderMaxCount: z.number().int(),
  allowedFileTypes: z.array(z.string()),
  maxFileSizeMb: z.number().int(),
  allowedAuthMethods: z.array(z.string()),
  certificateFormat: z.string(),
  retentionPolicyJson: z.record(z.string(), z.unknown()),
  publicFormsEnabled: z.boolean(),
  bulkSendMaxRowsPerJob: z.number().int(),
  bulkSendMaxActiveJobs: z.number().int(),
  bulkSendMaxRecipientsPerEnvelope: z.number().int(),
  senderRateLimitPerHour: z.number().int(),
  brandingJson: z.record(z.string(), z.unknown()).nullable(),
  webhookUrl: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const signWatermarkPolicyRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  scopeType: z.string(),
  scopeId: z.number().int().nullable(),
  text: z.string().nullable(),
  imageFileKey: z.string().nullable(),
  opacity: z.number().int(),
  angle: z.number().int(),
  color: z.string(),
  fontSize: z.number().int(),
  placement: z.string(),
  showOnFinalPdf: z.boolean(),
  previewOnly: z.boolean(),
  enabled: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listWatermarkPoliciesResponseSchema = z.array(signWatermarkPolicyRowSchema);

export const watermarkPolicyMutationResponseSchema = signWatermarkPolicyRowSchema;

export const reminderSweepResponseSchema = z.object({ remindedCount: z.number().int() });

export const expirationSweepResponseSchema = z.object({ expiredCount: z.number().int() });
