import { z } from "zod";

export const testAutomationSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type TestAutomationInput = z.infer<typeof testAutomationSchema>;

const automationConditionSchema = z.object({
  field: z.string().trim().min(1).max(50),
  op: z.enum(["eq", "neq", "contains", "gt", "lt", "exists"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const automationActionSchema = z.object({
  type: z.enum([
    "notify_roles",
    "notify_all",
    "email",
    "create_task",
    "webhook",
    "support_assign_ticket",
    "support_set_priority",
    "support_add_tag",
    "support_internal_note",
    "ai_classify",
    "ai_summarize",
    "ai_extract",
    "ai_routing_suggestion",
  ]),
  config: z.record(z.string(), z.unknown()),
});

export const createAutomationRuleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(150),
  description: z.string().trim().max(2000).optional(),
  triggerEvent: z.string().trim().min(1).max(100),
  conditions: z.array(automationConditionSchema).default([]),
  actions: z.array(automationActionSchema).default([]),
  isEnabled: z.boolean().default(true),
});

export const updateAutomationRuleSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  conditions: z.array(automationConditionSchema).optional(),
  actions: z.array(automationActionSchema).optional(),
  isEnabled: z.boolean().optional(),
});

export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
