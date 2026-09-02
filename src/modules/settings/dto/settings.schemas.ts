import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  scopes: z.array(z.string().min(1).max(100)).max(100).default([]),
  expiresAt: z.string().datetime().optional(),
}).strict();

export const customFieldsListSchema = z.object({
  entityType: z.string().optional(),
}).strict();

export const createCustomFieldSchema = z.object({
  entityType: z.enum(["lead", "deal", "contact"]),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, {
      message:
        "Name must be snake_case (lowercase letters, digits, underscores only, starting with a letter)",
    }),
  label: z.string().min(1),
  fieldType: z
    .enum(["text", "number", "date", "boolean", "select"])
    .default("text"),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
    .optional(),
  isRequired: z.boolean().optional().default(false),
  sortOrder: z.number().int().optional().default(0),
}).strict();

export const updateCustomFieldSchema = z.object({
  label: z.string().min(1).optional(),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
    .optional()
    .nullable(),
  isRequired: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
}).strict();

export const featureFlagSchema = z.object({
  flag: z.enum([
    "aiChat",
    "aiLeadScoring",
    "aiEmailDraft",
    "aiSmartNotifications",
    "aiWeeklyRecap",
    "supportAi",
  ]),
  enabled: z.boolean(),
}).strict();

export const createGitConnectionSchema = z.object({
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  repoUrl: z.string().url().max(500),
  repoName: z.string().max(200).optional(),
  projectId: z.number().int().positive().nullable().optional(),
}).strict();

export const updateGitConnectionSchema = z.object({
  isActive: z.boolean().optional(),
  repoUrl: z.string().url().max(500).optional(),
  repoName: z.string().max(200).nullable().optional(),
  projectId: z.number().int().positive().nullable().optional(),
}).strict();

const automationTriggerSchema = z.enum([
  "lead.created",
  "lead.status_changed",
  "lead.assigned",
  "lead.score_updated",
  "deal.created",
  "deal.stage_changed",
  "deal.won",
  "deal.lost",
  "ticket.created",
  "ticket.assigned",
  "ticket.status_changed",
  "ticket.escalated",
  "ticket.priority_changed",
  "ticket.message_received",
  "invoice.overdue",
  "invoice.paid",
  "candidate.application_created",
  "candidate.stage_changed",
  "candidate.bgv_status_changed",
  "interview.scheduled",
  "interview.completed",
  "scorecard.submitted",
  "offer.sent",
  "offer.accepted",
  "offer.rejected",
  "sla.breached",
  "onboarding.started",
  "onboarding.task_overdue",
  "onboarding.document_submitted",
  "onboarding.completed",
  "leave.requested",
  "leave.approved",
  "leave.rejected",
  "attendance.anomaly",
  "attendance.late",
  "resignation.submitted",
  "resignation.approved",
  "employee.onboarded",
  "employee.terminated",
  "employee.resignation",
  "certification.expiring",
  "document.review_requested",
  "performance.review_cycle_started",
  "review.cycle_started",
  "expense.submitted",
  "expense.approved",
  "reimbursement.approved",
  "reimbursement.rejected",
]);

const automationConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "contains", "gt", "lt", "exists"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();

const automationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify_roles"),
    config: z.object({
      roles: z.array(z.string().min(1)).min(1),
      title: z.string().min(1),
      message: z.string().min(1),
      link: z.string().optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("notify_all"),
    config: z.object({
      title: z.string().min(1),
      message: z.string().min(1),
      link: z.string().optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("email"),
    config: z.object({
      to: z.string().email(),
      subject: z.string().min(1),
      body: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("create_task"),
    config: z.object({
      title: z.string().min(1),
      assigneeId: z.string().optional(),
      dueInDays: z.number().int().min(0).optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("webhook"),
    config: z.object({
      event: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("support_assign_ticket"),
    config: z.object({
      assigneeId: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("support_set_priority"),
    config: z.object({
      priority: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("support_add_tag"),
    config: z.object({
      tagId: z.number().int().positive(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("support_internal_note"),
    config: z.object({
      body: z.string().min(1),
    }).strict(),
  }).strict(),
]);

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  triggerEvent: automationTriggerSchema,
  conditions: z.array(automationConditionSchema).max(50).default([]),
  actions: z.array(automationActionSchema).min(1).max(50),
  isEnabled: z.boolean().default(true),
}).strict();

export const updateAutomationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  triggerEvent: automationTriggerSchema.optional(),
  conditions: z.array(automationConditionSchema).max(50).optional(),
  actions: z.array(automationActionSchema).min(1).max(50).optional(),
  isEnabled: z.boolean().optional(),
}).strict();

export const updateUserRoleSchema = z.object({
  role: z.string().min(1),
}).strict();

export const listAutomationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type CustomFieldsListInput = z.infer<typeof customFieldsListSchema>;
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;
export type FeatureFlagInput = z.infer<typeof featureFlagSchema>;
export type CreateGitConnectionInput = z.infer<
  typeof createGitConnectionSchema
>;
export type UpdateGitConnectionInput = z.infer<
  typeof updateGitConnectionSchema
>;
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type ListAutomationsQueryInput = z.infer<
  typeof listAutomationsQuerySchema
>;

/** Section keys map to audit `action` prefixes, e.g. `org` -> `org.%`. */
export const SETTINGS_PROVENANCE_SECTIONS = [
  "org",
  "settings",
  "role",
  "webhook",
  "billing",
  "user",
] as const;

export const settingsProvenanceQuerySchema = z
  .object({
    sections: z
      .union([
        z.enum(SETTINGS_PROVENANCE_SECTIONS),
        z.array(z.enum(SETTINGS_PROVENANCE_SECTIONS)),
      ])
      .transform((v) => (Array.isArray(v) ? v : [v]))
      .refine((v) => v.length > 0, {
        message: "At least one section is required",
      }),
  })
  .strict();

export type SettingsProvenanceQuery = z.infer<
  typeof settingsProvenanceQuerySchema
>;
