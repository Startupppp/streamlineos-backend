import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const automationRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  trigger: z.string(),
  conditions: z.unknown(),
  actions: z.unknown(),
  isActive: z.boolean(),
  executionCount: z.number().int(),
  lastRunAt: nullableWireDate(),
  graph: z.unknown().nullable(),
  version: z.number().int(),
  isDraft: z.boolean(),
  lastError: z.string().nullable(),
  cooldownMinutes: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const automationRulesListSchema = z.object({
  rules: z.array(automationRuleSchema),
});

export const automationRuleSingleSchema = z.object({
  rule: automationRuleSchema,
});

export const automationEventSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  entityType: z.string(),
  isActive: z.boolean(),
  isSystemDefault: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const automationEventsListSchema = z.object({
  events: z.array(automationEventSchema),
});

export const automationActionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  configSchema: z.unknown().nullable(),
  isActive: z.boolean(),
  isSystemDefault: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const automationActionsListSchema = z.object({
  actions: z.array(automationActionSchema),
});

export const automationRunSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  ruleId: z.number().int(),
  eventKey: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  status: z.string(),
  steps: z.unknown().nullable(),
  error: z.string().nullable(),
  triggeredBy: z.string(),
  startedAt: wireDate(),
  finishedAt: nullableWireDate(),
});

export const automationRunsPageSchema = z.object({
  runs: z.array(automationRunSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const automationDryRunSchema = z.object({
  matched: z.boolean(),
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      type: z.string(),
      result: z.string(),
    }),
  ),
});
