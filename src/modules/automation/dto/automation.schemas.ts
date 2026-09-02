import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const testAutomationSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type TestAutomationInput = z.infer<typeof testAutomationSchema>;

export const automationConditionSchema = z.object({
  field: z.string().trim().min(1).max(50),
  op: z.enum(["eq", "neq", "contains", "gt", "lt", "exists"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export type AutomationCondition = z.infer<typeof automationConditionSchema>;

export const automationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify_roles"),
    config: z.object({
      roles: z.array(z.string()),
      title: z.string(),
      message: z.string(),
      link: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("notify_all"),
    config: z.object({
      title: z.string(),
      message: z.string(),
      link: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("email"),
    config: z.object({
      to: z.union([z.string(), z.array(z.string())]),
      subject: z.string(),
      body: z.string(),
    }),
  }),
  z.object({
    type: z.literal("create_task"),
    config: z.object({
      title: z.string(),
      assigneeId: z.string().optional(),
      dueInDays: z.number().int().min(0).optional(),
    }),
  }),
  z.object({
    type: z.literal("webhook"),
    config: z.object({
      event: z.string(),
    }),
  }),
  z.object({
    type: z.literal("support_assign_ticket"),
    config: z.object({
      assigneeId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("support_set_priority"),
    config: z.object({
      priority: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("support_add_tag"),
    config: z.object({
      tagId: z.number().int(),
    }),
  }),
  z.object({
    type: z.literal("support_internal_note"),
    config: z.object({
      body: z.string(),
    }),
  }),
  z.object({
    type: z.literal("ai_classify"),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("ai_summarize"),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("ai_extract"),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("ai_routing_suggestion"),
    config: z.record(z.string(), z.unknown()),
  }),
]);

export type AutomationAction = z.infer<typeof automationActionSchema>;

export const createAutomationRuleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(150),
  description: z.string().trim().max(2000).optional(),
  triggerEvent: z.string().trim().min(1).max(100),
  conditions: z.array(automationConditionSchema).default([]),
  actions: z.array(automationActionSchema).default([]),
  isEnabled: z.boolean().default(true),
}).strict();

export const updateAutomationRuleSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  triggerEvent: z.string().trim().min(1).max(100).optional(),
  conditions: z.array(automationConditionSchema).optional(),
  actions: z.array(automationActionSchema).optional(),
  isEnabled: z.boolean().optional(),
}).strict();

export const listSupportAutomationsQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
}).strict();

export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
export type ListSupportAutomationsQueryInput = z.infer<typeof listSupportAutomationsQuerySchema>;
