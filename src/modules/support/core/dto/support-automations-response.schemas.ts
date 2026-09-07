import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const automationRuleRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  triggerEvent: z.string(),
  conditions: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  isEnabled: z.boolean(),
  runCount: z.number().int(),
  lastRunAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const automationRuleListSchema = z.object({
  data: z.array(automationRuleRowSchema),
  pagination: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export const automationRunRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ruleId: z.number().int(),
  triggerEvent: z.string(),
  status: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: wireDate(),
});

export const automationRunListSchema = z.array(automationRunRowSchema);

export const testRuleResultSchema = z.object({
  runId: z.number().int(),
  matched: z.boolean(),
  status: z.enum(["skipped", "success", "failed"]),
  actionResults: z.array(
    z.object({
      type: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});

export { successSchema };
