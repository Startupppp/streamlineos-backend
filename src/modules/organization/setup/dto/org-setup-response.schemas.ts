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

export const orgSetupStatusResponseSchema = z.object({
  orgId: z.string().nullable(),
  onboardingCompletedAt: nullableWireDate(),
  provisioning: z.enum([
    "not-started",
    "pending",
    "in-progress",
    "completed",
    "failed",
  ]),
  lastError: z.string().nullable(),
});
