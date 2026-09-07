import { z } from "zod";
import type { AutomationGraphNode } from "../../../../db/schema/crm/automation-rules";

const GRAPH_NODE_LIMIT = 200;
const COOLDOWN_MAX_MINUTES = 60 * 24 * 30;

type AutomationGraphNodeInput = AutomationGraphNode;

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

const automationGraphNodeSchema: z.ZodType<AutomationGraphNodeInput> = z.object({
  id: z.string().min(1).max(100),
  type: z.string().min(1).max(50),
  config: z.record(z.string(), z.unknown()).optional(),
  nextId: z.string().min(1).max(100).optional(),
  branches: z
    .array(
      z.object({
        condition: z.record(z.string(), z.unknown()),
        nextId: z.string().min(1).max(100),
      }),
    )
    .max(GRAPH_NODE_LIMIT)
    .optional(),
});

/**
 * `graph`, `isDraft` and `cooldownMinutes` are author-owned and MUST be
 * accepted — they are real columns the visual builder sends, and omitting them
 * silently discarded the canvas layout on every save. `executionCount`,
 * `lastRunAt`, `version` and `createdAt` are server-owned and stay undeclared,
 * so `.strict()` now rejects them instead of quietly ignoring them (§20 A03).
 */
export const createAutomationRuleSchema = z
  .object({
    name: z.string().min(1, "Name required").max(100),
    trigger: automationTriggerEnum,
    conditions: z.array(automationConditionSchema).min(1, "At least one condition required"),
    actions: z.array(automationActionEnum).min(1, "At least one action required"),
    isActive: z.boolean().default(true),
    graph: z.array(automationGraphNodeSchema).max(GRAPH_NODE_LIMIT).nullable().optional(),
    isDraft: z.boolean().optional(),
    cooldownMinutes: z.number().int().min(0).max(COOLDOWN_MAX_MINUTES).optional(),
  })
  .strict();

export const updateAutomationRuleSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    trigger: automationTriggerEnum.optional(),
    conditions: z.array(automationConditionSchema).min(1).optional(),
    actions: z.array(automationActionEnum).min(1).optional(),
    isActive: z.boolean().optional(),
    graph: z.array(automationGraphNodeSchema).max(GRAPH_NODE_LIMIT).nullable().optional(),
    isDraft: z.boolean().optional(),
    cooldownMinutes: z.number().int().min(0).max(COOLDOWN_MAX_MINUTES).optional(),
  })
  .strict();

export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;

export const automationRunsQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type AutomationRunsQueryInput = z.infer<typeof automationRunsQuerySchema>;
