import { z } from "zod";

const conditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["equals", "not_equals", "contains", "is_empty", "is_not_empty"]),
  value: z.string().optional(),
});

const actionSchema = z.object({
  type: z.enum(["set_status", "set_assignee", "set_priority", "add_label", "add_comment"]),
  value: z.string().min(1),
});

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(200),
  triggerEvent: z.enum([
    "ticket.created",
    "ticket.updated",
    "ticket.status_changed",
    "ticket.assigned",
    "sprint.started",
    "sprint.completed",
  ]),
  conditions: z.array(conditionSchema).default([]),
  actions: z.array(actionSchema).min(1),
  isActive: z.boolean().default(true),
}).strict();
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = createAutomationSchema.partial().strict();
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;
