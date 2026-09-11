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

/**
 * `GET /sign/admin/sweep-status`. Both sweeps are always reported, so `neverRun`
 * is a real state rather than an absent row — that distinction is the whole
 * point of the endpoint. `ranAt` is already an ISO string here: `lastRuns` calls
 * `toISOString()` itself rather than handing the column's `Date` through.
 */
export const sweepStatusResponseSchema = z.object({
  sweeps: z.array(z.object({
    sweep: z.enum(["reminder", "expiration"]),
    ranAt: z.string().nullable(),
    affected: z.number().int().nonnegative(),
    error: z.string().nullable(),
    neverRun: z.boolean(),
    staleness: z.enum(["ok", "never_run", "stale", "errored"]),
    healthy: z.boolean(),
    expectedWithinHours: z.number().int(),
  })),
});

/**
 * `GET /sign/admin/sweep-preview`. `truncated` says the listing hit the preview
 * ceiling, so `entries` is shorter than `envelopes` — without it a capped
 * preview is indistinguishable from a complete one.
 */
export const sweepPreviewResponseSchema = z.object({
  sweep: z.enum(["reminder", "expiration"]),
  envelopes: z.number().int().nonnegative(),
  affected: z.number().int().nonnegative(),
  entries: z.array(z.object({
    envelopeId: z.number().int(),
    title: z.string(),
    affected: z.number().int().nonnegative(),
  })),
  truncated: z.boolean(),
});
