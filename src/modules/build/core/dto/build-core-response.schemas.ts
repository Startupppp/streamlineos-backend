import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, idCursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { DB_ENUMS } from "../../../../db/enums.generated";
import { releaseStatusSchema } from "./releases.schemas";

const webhookDeliveryStatusSchema = z.enum(["pending", "success", "failed"]);

export const ticketLabelSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  color: z.string(),
  createdAt: wireDate(),
});

export const projectMemberSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  image: z.string().nullable(),
  email: z.string(),
  role: z.string(),
  joinedAt: wireDate(),
});

export const projectMemberPageSchema = cursorPageSchema(projectMemberSchema);

export const projectRosterSchema = z.object({
  teams: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    key: z.string(),
  })),
  members: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  })),
});

export const projectMemberRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  membershipId: z.number().int(),
  role: z.string(),
  hourlyRate: z.string(),
  hourlyRateMinor: z.number().int(),
  rateCurrency: z.string().nullable(),
  joinedAt: wireDate(),
});

export const memberRoleSchema = z.object({
  id: z.number().int(),
  membershipId: z.number().int(),
  role: z.string(),
  userId: z.string(),
});

export const projectCustomStateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  order: z.number().int(),
  color: z.string().nullable(),
  type: z.enum(DB_ENUMS.state_group).nullable(),
  wipLimit: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const bulkReorderStatesResultSchema = z.object({
  items: z.array(z.object({
    id: z.number().int(),
    order: z.number().int(),
  })),
});

export const orgCustomStateSchema = z.object({
  name: z.string(),
  color: z.string().nullable(),
  type: z.enum(DB_ENUMS.state_group).nullable(),
});

export const buildCustomFieldSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int().nullable(),
  name: z.string(),
  type: z.string(),
  options: z.array(z.string()).nullable(),
  required: z.boolean().nullable(),
  position: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const ticketFieldValueSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  fieldId: z.number().int(),
  value: z.unknown(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  field: z.object({
    id: z.number().int(),
    orgId: z.string(),
    projectId: z.number().int().nullable(),
    name: z.string(),
    type: z.string(),
    options: z.array(z.string()).nullable(),
    required: z.boolean().nullable(),
    position: z.number().int().nullable(),
    createdAt: wireDate(),
  }),
});

export const projectReleaseListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  version: z.string(),
  rowVersion: z.number().int(),
  description: z.string().nullable(),
  status: releaseStatusSchema,
  releaseDate: z.string().nullable(),
  publishedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdByUser: z.object({
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
  }).nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  ticketCount: z.number().int(),
});

export const projectReleaseListPageSchema = cursorPageSchema(projectReleaseListItemSchema);

export const projectReleaseRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  version: z.string(),
  rowVersion: z.number().int(),
  description: z.string().nullable(),
  status: releaseStatusSchema,
  releaseDate: z.string().nullable(),
  publishedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  deletedAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const projectWebhookSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  url: z.string(),
  events: z.array(z.string()),
  isActive: z.boolean(),
  hasSecret: z.boolean(),
  secretSetAt: nullableWireDate(),
  version: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lastDeliveryAt: nullableWireDate(),
  lastDeliveryStatus: webhookDeliveryStatusSchema.nullable(),
  failureRate: z.number().nullable(),
});

export const projectWebhookPageSchema = idCursorPageSchema(projectWebhookSchema);

export const webhookDeliverySchema = z.object({
  id: z.number().int(),
  webhookId: z.number().int(),
  event: z.string(),
  status: webhookDeliveryStatusSchema,
  responseCode: z.number().int().nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  deliveredAt: wireDate(),
});

export const webhookTestResultSchema = z.object({
  success: z.boolean(),
  responseCode: z.number().int().nullable(),
});

const automationConditionSchema = z.object({
  field: z.string(),
  operator: z.enum(["equals", "not_equals", "contains", "is_empty", "is_not_empty"]),
  value: z.string().optional(),
});

const automationActionSchema = z.object({
  type: z.enum(["set_status", "set_assignee", "set_priority", "add_label", "add_comment"]),
  value: z.string(),
});

const automationCreatedByUserSchema = z.object({
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
});

export const projectAutomationListItemSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  name: z.string(),
  triggerEvent: z.string(),
  isActive: z.boolean(),
  conditions: z.array(automationConditionSchema),
  actions: z.array(automationActionSchema),
  createdBy: z.string().nullable(),
  createdByUser: automationCreatedByUserSchema.nullable(),
  lastRunAt: wireDate().nullable(),
  lastFailureAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const projectAutomationListPageSchema = cursorPageSchema(projectAutomationListItemSchema);

export const projectAutomationRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  isActive: z.boolean(),
  triggerEvent: z.string(),
  conditions: z.array(automationConditionSchema),
  actions: z.array(automationActionSchema),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const automationRunOutcomeSchema = z.enum(DB_ENUMS.automation_run_outcome);

export const automationRunActionRowSchema = z.object({
  id: z.number().int(),
  actionIndex: z.number().int(),
  actionType: z.string(),
  outcome: z.enum(DB_ENUMS.automation_action_outcome),
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
});

export const automationRunRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  automationId: z.number().int().nullable(),
  ticketId: z.number().int().nullable(),
  triggerEvent: z.string(),
  matched: z.boolean(),
  outcome: automationRunOutcomeSchema,
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
  actions: z.array(automationRunActionRowSchema),
});

export const automationRunListSchema = z.object({
  items: z.array(automationRunRowSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const buildMemberItemSchema = z.object({
  id: z.string(),
  role: z.string(),
  addedAt: wireDate(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  teams: z.array(z.string()),
});

export const buildMemberPageSchema = cursorPageSchema(buildMemberItemSchema);

export const buildMemberRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  membershipId: z.number().int(),
  role: z.string(),
  addedAt: wireDate(),
});

const projectMemberPreviewSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  image: z.string().nullable(),
});

const projectManagerSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  image: z.string().nullable(),
});

export const projectListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  key: z.string(),
  status: z.enum(DB_ENUMS.project_status),
  priority: z.string().nullable(),
  startDate: wireDate().nullable(),
  endDate: wireDate().nullable(),
  managedProductId: z.number().int().nullable(),
  manager: projectManagerSchema.nullable(),
  progress: z.object({
    total: z.number().int(),
    done: z.number().int(),
    percentage: z.number().int(),
  }),
  health: z.enum(["on_track", "at_risk", "off_track"]),
  members: z.array(projectMemberPreviewSchema),
  teams: z.array(z.string()),
});

export const projectListPageSchema = idCursorPageSchema(projectListItemSchema);

export const linkManagedProductResultSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  key: z.string(),
  managedProductId: z.number().int().nullable(),
});

const recentProjectManagerSchema = z.object({
  id: z.number().int(),
  user: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      image: z.string().nullable(),
    })
    .nullable(),
});

export const recentProjectsSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    key: z.string(),
    manager: recentProjectManagerSchema.nullable().optional(),
  }),
);

export const buildRestoreResultSchema = z.object({
  restored: z.literal(true),
  restoredChildren: z.number().int().nonnegative(),
});

export type BuildRestoreResult = z.infer<typeof buildRestoreResultSchema>;
