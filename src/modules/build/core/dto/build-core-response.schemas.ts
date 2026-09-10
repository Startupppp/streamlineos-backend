import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, idCursorPageSchema } from "../../../../common/openapi/response-envelopes";

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
  type: z.string(),
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
  description: z.string().nullable(),
  status: z.string(),
  releaseDate: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  ticketCount: z.number().int(),
});

export const projectReleaseRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  releaseDate: z.string().nullable(),
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
  createdAt: wireDate(),
});

export const webhookDeliverySchema = z.object({
  id: z.number().int(),
  webhookId: z.number().int(),
  event: z.string(),
  status: z.string(),
  responseCode: z.number().int().nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  deliveredAt: wireDate(),
});

export const webhookTestResultSchema = z.object({
  success: z.boolean(),
  responseCode: z.number().int().nullable(),
});

export const projectAutomationListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  triggerEvent: z.string(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
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

export const workspaceMemberItemSchema = z.object({
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

export const workspaceMemberPageSchema = cursorPageSchema(workspaceMemberItemSchema);

export const workspaceMemberRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  membershipId: z.number().int(),
  role: z.string(),
  pmWorkspaceId: z.string(),
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
  status: z.string(),
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
