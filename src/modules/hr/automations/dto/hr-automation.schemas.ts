import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { hrAutomationEventSchema } from "../hr-automation-events";

const conditionSchema = z.object({
  field: z.string().trim().min(1).max(100),
  operator: z.enum(["eq", "neq", "in", "gte", "lte", "contains"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});

const createTaskActionSchema = z.object({
  type: z.literal("create_task"),
  config: z.object({
    title: z.string().trim().min(1).max(255),
    assigneeId: z.string().optional(),
    dueInDays: z.number().int().min(0).optional(),
  }),
});

const startWorkflowActionSchema = z.object({
  type: z.literal("start_workflow"),
  config: z.object({ workflowId: z.string().trim().min(1) }),
});

const sendNotificationActionSchema = z.object({
  type: z.literal("send_notification"),
  config: z.object({
    title: z.string().trim().min(1).max(255),
    message: z.string().trim().min(1).max(2000),
    link: z.string().url().optional(),
    roles: z.array(z.string()).optional(),
  }),
});

const sendEmailActionSchema = z.object({
  type: z.literal("send_email"),
  config: z.object({
    to: z.string().email(),
    subject: z.string().trim().min(1).max(255),
    body: z.string().trim().min(1),
  }),
});

const assignDocumentActionSchema = z.object({
  type: z.literal("assign_document"),
  config: z.object({ documentTypeId: z.number().int().positive() }),
});

const generateLetterActionSchema = z.object({
  type: z.literal("generate_letter"),
  config: z.object({ templateId: z.number().int().positive() }),
});

const assignCourseActionSchema = z.object({
  type: z.literal("assign_course"),
  config: z.object({ courseId: z.number().int().positive() }),
});

const assignAssetActionSchema = z.object({
  type: z.literal("assign_asset"),
  config: z.object({ assetTypeId: z.number().int().positive() }),
});

const createHrCaseActionSchema = z.object({
  type: z.literal("create_hr_case"),
  config: z.object({
    subject: z.string().trim().min(1).max(255),
    categoryId: z.number().int().positive().optional(),
  }),
});

const updateFieldActionSchema = z.object({
  type: z.literal("update_field"),
  config: z.object({
    field: z.string().trim().min(1).max(100),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
});

const callWebhookActionSchema = z.object({
  type: z.literal("call_webhook"),
  config: z.object({
    url: z.string().url().refine((u) => u.startsWith("https://"), "Must be HTTPS"),
    method: z.enum(["POST", "PUT"]).default("POST"),
  }),
});

export const hrAutomationActionSchema = z.discriminatedUnion("type", [
  createTaskActionSchema,
  startWorkflowActionSchema,
  sendNotificationActionSchema,
  sendEmailActionSchema,
  assignDocumentActionSchema,
  generateLetterActionSchema,
  assignCourseActionSchema,
  assignAssetActionSchema,
  createHrCaseActionSchema,
  updateFieldActionSchema,
  callWebhookActionSchema,
]);

export const createHrAutomationRuleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(150),
  description: z.string().trim().max(2000).optional(),
  triggerEvent: hrAutomationEventSchema,
  conditions: z.array(conditionSchema).default([]),
  actions: z.array(hrAutomationActionSchema).min(1, "At least one action is required"),
  isEnabled: z.boolean().default(true),
}).strict();

export const updateHrAutomationRuleSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  triggerEvent: hrAutomationEventSchema.optional(),
  conditions: z.array(conditionSchema).optional(),
  actions: z.array(hrAutomationActionSchema).optional(),
  isEnabled: z.boolean().optional(),
}).strict();

export const testHrAutomationSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const toggleHrAutomationRuleSchema = z.object({ isEnabled: z.boolean() }).strict();
export type ToggleHrAutomationRuleInput = z.infer<typeof toggleHrAutomationRuleSchema>;

/**
 * PRD-C048 — `GET /hr/automations` used to bind five raw `@Query(...)` strings and
 * clamp `page`/`limit` by hand. A hand-rolled clamp is invisible to `@Validate`, so the
 * page-size cap never reached `openapi.json`, and `search`/`triggerEvent`/`isEnabled`
 * arrived as unvalidated strings. `isEnabled` keeps its tri-state: absent means "either".
 */
export const listHrAutomationRulesSchema = z.object({
  limit: pageSizeField(50, 100),
  search: z.string().trim().min(1).max(200).optional(),
  triggerEvent: hrAutomationEventSchema.optional(),
  isEnabled: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
}).strict();

export const listRunsSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
}).strict();

export type CreateHrAutomationRuleInput = z.infer<typeof createHrAutomationRuleSchema>;
export type UpdateHrAutomationRuleInput = z.infer<typeof updateHrAutomationRuleSchema>;
export type TestHrAutomationInput = z.infer<typeof testHrAutomationSchema>;
export type ListRunsInput = z.infer<typeof listRunsSchema>;
export type ListHrAutomationRulesInput = z.infer<typeof listHrAutomationRulesSchema>;
