import { z } from "zod";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const workflowStepRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  definitionId: z.number().int(),
  stepOrder: z.number().int(),
  name: z.string(),
  approverType: z.string(),
  approverValue: z.string().nullable(),
  mode: z.string(),
  slaHours: z.number().int().nullable(),
  escalationApproverType: z.string().nullable(),
  escalationApproverValue: z.string().nullable(),
  condition: z.unknown().nullable(),
});

export const workflowDefinitionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  objectType: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.number().int(),
  isDefault: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const workflowDefinitionWithStepsSchema = workflowDefinitionRowSchema.extend({
  steps: z.array(workflowStepRowSchema),
});

export const workflowDefinitionListSchema = cursorPageSchema(
  workflowDefinitionRowSchema.extend({ stepCount: z.number().int() }),
);

const simulateStepSchema = z.object({
  stepOrder: z.number().int(),
  name: z.string(),
  mode: z.string(),
  approverType: z.string(),
  conditionPasses: z.boolean(),
  resolvedApproverUserIds: z.array(z.string()),
  slaHours: z.number().int().nullable(),
});

export const workflowSimulateResponseSchema = z.object({
  workflowId: z.number().int(),
  name: z.string(),
  objectType: z.string(),
  status: z.string(),
  version: z.number().int(),
  subjectEmployeeId: z.string(),
  steps: z.array(simulateStepSchema),
  explanation: z.string(),
});

export const workflowInstanceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  definitionId: z.number().int(),
  definitionSnapshot: z.record(z.string(), z.unknown()),
  objectType: z.string(),
  objectId: z.string(),
  requestedBy: z.string(),
  requestedByMembershipId: z.number().int().nullable(),
  subjectEmployeeId: z.string(),
  subjectEmployeeMembershipId: z.number().int().nullable(),
  context: z.record(z.string(), z.unknown()),
  status: z.string(),
  currentStepOrder: z.number().int(),
  dueAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const workflowInstanceListAllSchema = cursorPageSchema(
  workflowInstanceRowSchema.extend({
    requesterName: z.string().nullable(),
    requesterEmail: z.string().nullable(),
  }),
);

export const workflowInstancePagedSchema = cursorPageSchema(workflowInstanceRowSchema);

export const workflowInboxSchema = z.object({
  data: z.array(workflowInstanceRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

const workflowUserRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
});

const workflowAttachmentSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  name: z.string(),
});

const workflowTimelineActionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  instanceId: z.number().int(),
  stepOrder: z.number().int(),
  approverUserId: z.string(),
  approverMembershipId: z.number().int().nullable(),
  actedByUserId: z.string(),
  actedByMembershipId: z.number().int().nullable(),
  action: z.string(),
  comment: z.string().nullable(),
  actedAt: wireDate(),
  attachments: z.array(workflowAttachmentSchema),
  approver: workflowUserRefSchema.optional(),
  actedBy: workflowUserRefSchema.optional(),
});

export const workflowInstanceDetailSchema = workflowInstanceRowSchema.extend({
  requester: workflowUserRefSchema.optional(),
  subjectEmployee: workflowUserRefSchema.optional(),
  timeline: z.array(workflowTimelineActionSchema),
});

export const workflowDelegationWithUserSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  delegatorUserId: z.string(),
  delegateUserId: z.string(),
  objectType: z.string().nullable(),
  startsAt: wireDate(),
  endsAt: wireDate(),
  reason: z.string().nullable(),
  active: z.boolean(),
  createdAt: wireDate(),
  delegateName: z.string().nullable(),
  delegateEmail: z.string().nullable(),
});

export const workflowDelegationRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  delegatorUserId: z.string(),
  delegatorMembershipId: z.number().int().nullable(),
  delegateUserId: z.string(),
  delegateMembershipId: z.number().int().nullable(),
  objectType: z.string().nullable(),
  startsAt: wireDate(),
  endsAt: wireDate(),
  reason: z.string().nullable(),
  active: z.boolean(),
  createdAt: wireDate(),
});
