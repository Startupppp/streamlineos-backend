import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

export const platformContactResponseSchema = z.object({ ok: z.literal(true) });

const orgStatusEnum = z.enum(["ACTIVE", "ARCHIVED", "PURGE_SCHEDULED", "PURGED"]);

const orgRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: orgStatusEnum,
  createdAt: wireDate(),
});

const memberRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  joinedAt: wireDate(),
});

export const operatorCustomerResponseSchema = z.object({
  organization: orgRowSchema,
  members: z.array(memberRowSchema),
});

const subscriptionPlanEnum = z.enum(["STARTER", "PROFESSIONAL", "ENTERPRISE"]);
const subscriptionStatusEnum = z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "CANCELLED", "SUSPENDED", "EXPIRED"]);

const subscriptionRowSchema = z.object({
  id: z.number().int().positive(),
  plan: subscriptionPlanEnum,
  status: subscriptionStatusEnum,
  currentPeriodStart: wireDate(),
  currentPeriodEnd: wireDate(),
  trialEndsAt: wireDate().nullable(),
  cancelledAt: wireDate().nullable(),
});

const paymentRowSchema = z.object({
  id: z.number().int().positive(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.string(),
  method: z.string().nullable(),
  description: z.string().nullable(),
  capturedAt: wireDate().nullable(),
  refundedAt: wireDate().nullable(),
  createdAt: wireDate(),
});

export const operatorBillingResponseSchema = z.object({
  subscription: subscriptionRowSchema.nullable(),
  payments: z.array(paymentRowSchema),
});
