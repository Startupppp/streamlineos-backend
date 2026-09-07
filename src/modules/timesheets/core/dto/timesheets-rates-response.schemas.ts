import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const rateCardSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  currency: z.string(),
  isDefault: z.boolean(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const rateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  rateCardId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  userMembershipId: z.number().int().nullable(),
  clientId: z.number().int().nullable(),
  taskId: z.number().int().nullable(),
  billingType: z.string(),
  billRate: z.string(),
  costRate: z.string().nullable(),
  currency: z.string(),
  priority: z.number().int(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const ratesListResponseSchema = z.object({
  rates: z.array(rateSchema),
  rateCards: z.array(rateCardSchema),
});
