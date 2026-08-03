import { z } from "zod";

const automationConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["equals", "contains", "greater_than", "less_than", "is_empty"]),
  value: z.string().min(1),
});

const automationTriggerEnum = z.enum([
  "lead.created",
  "lead.status_changed",
  "lead.score_changed",
  "lead.assigned",
  "deal.stage_changed",
  "task.overdue",
]);

const automationActionEnum = z.enum([
  "send_email",
  "assign_to",
  "update_field",
  "create_task",
  "send_notification",
  "add_tag",
]);

export const createAutomationRuleSchema = z.object({
  name: z.string().min(1, "Name required").max(100),
  trigger: automationTriggerEnum,
  conditions: z.array(automationConditionSchema).min(1, "At least one condition required"),
  actions: z.array(automationActionEnum).min(1, "At least one action required"),
  isActive: z.boolean().default(true),
});

export const updateAutomationRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  trigger: automationTriggerEnum.optional(),
  conditions: z.array(automationConditionSchema).min(1).optional(),
  actions: z.array(automationActionEnum).min(1).optional(),
  isActive: z.boolean().optional(),
});

export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
