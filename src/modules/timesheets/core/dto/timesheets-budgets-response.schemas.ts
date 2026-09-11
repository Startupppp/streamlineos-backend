import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const burnResultSchema = z.object({
  budget: z.number(),
  consumed: z.number(),
  percentUsed: z.number(),
  remaining: z.number(),
  alertLevel: z.number(),
  over: z.boolean(),
});

export const budgetItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  clientId: z.number().int().nullable(),
  budgetType: z.string(),
  budgetHours: z.string().nullable(),
  budgetAmount: z.string().nullable(),
  currency: z.string(),
  alertThresholds: z.array(z.number()),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  burn: burnResultSchema,
});

export const budgetListResponseSchema = z.array(budgetItemSchema);
