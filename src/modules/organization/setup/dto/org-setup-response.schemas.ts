import { z } from "zod";
import {
  wireDate,
  nullableWireDate,
} from "../../../../common/openapi/wire-types";

export const orgMemberItemSchema = z.object({
  userId: z.string().optional(),
  membershipId: z.number().int().optional(),
  name: z.string().nullable().optional(),
  email: z.string().optional(),
  image: z.string().nullable().optional(),
  status: z.string().optional(),
});

export const orgMemberListResponseSchema = z.array(orgMemberItemSchema);

export const orgSetupSessionResponseSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  status: z.string(),
  currentStep: z.string().nullable(),
  completedSteps: z.array(z.string()),
  skippedSteps: z.array(z.string()),
  data: z.record(z.string(), z.unknown()),
  orgId: z.string().optional(),
  userId: z.string().optional(),
  membershipId: z.number().int().nullable().optional(),
  source: z.string().nullable().optional(),
  startedAt: nullableWireDate().optional(),
  completedAt: nullableWireDate().optional(),
  lastSeenAt: wireDate().optional(),
  createdAt: wireDate().optional(),
  updatedAt: wireDate().optional(),
});

export const orgSetupCompleteResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    orgId: z.string(),
    autoLoginToken: z.string(),
  }),
  z.object({ success: z.literal(true), orgId: z.string() }),
]);

export const orgSetupSkipResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    orgId: z.string(),
    autoLoginToken: z.string(),
  }),
  z.object({ success: z.literal(true), orgId: z.string() }),
]);

export const ORG_SETUP_STATUS_ERROR_CODES = [
  "SETUP_BACKGROUND_PARTIAL",
  "SETUP_BACKGROUND_RETRYING",
  "SETUP_BACKGROUND_DEAD",
  "SETUP_BACKGROUND_INVALID",
  "SETUP_BACKGROUND_SUPPRESSED",
] as const;

export const orgSetupStatusErrorCodeSchema = z.enum(
  ORG_SETUP_STATUS_ERROR_CODES,
);

export const inviteeOutcomeSchema = z.enum([
  "successful",
  "queued",
  "failed",
  "skipped",
]);

export const inviteeFailureReasonSchema = z.enum([
  "already_member",
  "invitation_revoked",
  "unknown",
]);

export const recipientOutcomeSchema = z.object({
  email: z.string(),
  outcome: inviteeOutcomeSchema,
  reason: inviteeFailureReasonSchema.nullable(),
});

export const orgSetupStatusResponseSchema = z.object({
  orgId: z.string().nullable(),
  onboardingCompletedAt: nullableWireDate(),
  ready: z.boolean(),
  provisioning: z.enum([
    "not-started",
    "pending",
    "in-progress",
    "completed",
    "failed",
  ]),
  errorCode: orgSetupStatusErrorCodeSchema.nullable(),
  correlationId: z.string().nullable(),
  recipientOutcomes: z.array(recipientOutcomeSchema).nullable(),
});
