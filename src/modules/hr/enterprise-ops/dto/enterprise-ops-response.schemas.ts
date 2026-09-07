import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const accommodationRequestSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  type: z.enum(["equipment", "schedule", "workspace", "medical_restriction", "other"]),
  description: z.string(),
  confidentialMedicalNote: z.string().nullable(),
  status: z.enum(["requested", "under_review", "approved", "denied", "implemented"]),
  reviewedBy: z.string().nullable(),
  reviewDate: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const accommodationTaskSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  requestId: z.string(),
  title: z.string(),
  assigneeUserId: z.string().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  status: z.enum(["pending", "in_progress", "completed"]),
  dueDate: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listAccommodationsResponseSchema = cursorPageSchema(accommodationRequestSchema);
export const getAccommodationResponseSchema = accommodationRequestSchema;
export const createAccommodationResponseSchema = accommodationRequestSchema;
export const updateAccommodationResponseSchema = accommodationRequestSchema;
export const approveAccommodationResponseSchema = accommodationRequestSchema;

export const listAccommodationTasksResponseSchema = z.array(accommodationTaskSchema);
export const createAccommodationTaskResponseSchema = accommodationTaskSchema;
export const updateAccommodationTaskResponseSchema = accommodationTaskSchema;

const emergencyEventSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  type: z.enum(["office_closure", "disaster", "safety_check", "other"]),
  locationId: z.string().nullable(),
  status: z.enum(["active", "resolved"]),
  message: z.string(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  resolvedAt: nullableWireDate(),
});

const emergencyResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  eventId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  status: z.enum(["safe", "need_help", "no_response"]),
  respondedAt: nullableWireDate(),
  note: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listEmergencyEventsResponseSchema = cursorPageSchema(emergencyEventSchema);
export const getEmergencyEventResponseSchema = emergencyEventSchema;
export const createEmergencyEventResponseSchema = emergencyEventSchema;
export const updateEmergencyEventResponseSchema = emergencyEventSchema;
export const broadcastResponseSchema = z.object({
  broadcasted: z.number().int(),
  notified: z.number().int(),
  eventId: z.string(),
});
export const respondToEventResponseSchema = emergencyResponseSchema;
export const getEventStatusResponseSchema = z.object({
  eventId: z.string(),
  aggregate: z.object({
    safe: z.number().int(),
    need_help: z.number().int(),
    no_response: z.number().int(),
  }),
  byLocation: z.record(z.string(), z.unknown()),
  total: z.number().int(),
});

const hrEventSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  eventType: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  actorUserId: z.string().nullable(),
  occurredAt: wireDate(),
});

export const listHrEventsResponseSchema = cursorPageSchema(hrEventSchema);
export const getDataDictionaryResponseSchema = z.object({
  catalog: z.array(z.object({ eventType: z.string(), description: z.string(), entityTypes: z.array(z.string()) })),
  sanitizedFields: z.array(z.string()),
  immutable: z.boolean(),
  note: z.string(),
});
export const exportHrEventsResponseSchema = z.object({
  exportedAt: z.string(),
  data: z.array(hrEventSchema),
  pagination: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

const accessProvisioningSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  systemName: z.string(),
  action: z.enum(["grant", "revoke", "review"]),
  status: z.enum(["pending", "completed", "verified", "failed"]),
  triggeredBy: z.enum(["joiner", "mover", "leaver", "manual"]),
  requestedAt: wireDate(),
  completedAt: nullableWireDate(),
  verifiedBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const accessTemplateSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  triggeredBy: z.enum(["joiner", "mover", "leaver", "manual"]),
  systemsConfig: z.array(z.object({ systemName: z.string(), action: z.enum(["grant", "revoke", "review"]) })),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listProvisioningResponseSchema = cursorPageSchema(accessProvisioningSchema);
export const createProvisioningResponseSchema = accessProvisioningSchema;
export const updateProvisioningResponseSchema = accessProvisioningSchema;

export const listTemplatesResponseSchema = z.array(accessTemplateSchema);
export const createTemplateResponseSchema = accessTemplateSchema;
export const updateTemplateResponseSchema = accessTemplateSchema;

export const generateProvisioningResponseSchema = z.object({
  generated: z.number().int(),
  records: z.array(accessProvisioningSchema).optional(),
});
export const getExitVerificationResponseSchema = z.object({
  userId: z.string(),
  hasUnverifiedRevokes: z.boolean(),
  unverified: z.array(accessProvisioningSchema),
  total: z.number().int(),
});

const simulationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.enum(["policy", "leave", "attendance", "approval", "payroll"]),
  input: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: wireDate(),
});

export const listSimulationsResponseSchema = cursorPageSchema(simulationSchema);
export const simulatePolicyResponseSchema = z.object({
  simulation: z.string(),
  matchedPolicy: z.record(z.string(), z.unknown()).nullable(),
  hypotheticalContext: z.record(z.string(), z.unknown()).optional(),
});
export const simulateLeaveBalanceResponseSchema = z.object({
  simulation: z.string(),
  currentBalance: z.number(),
  hypotheticalAccrualRate: z.number(),
  projectionMonths: z.number().int(),
  projectedBalance: z.number(),
  projectionDate: z.string(),
});
export const simulateApprovalRoutingResponseSchema = z.object({
  simulation: z.string(),
  objectType: z.string(),
  employeeId: z.string(),
  matchedWorkflow: z.object({ id: z.number().int(), name: z.string(), version: z.number().int() }).nullable(),
  resolvedSteps: z.array(z.object({
    stepId: z.string(),
    stepOrder: z.number().int(),
    stepName: z.string(),
    approverType: z.string(),
    approverRef: z.string().nullable(),
    mode: z.string(),
    workflowName: z.string(),
    approvers: z.array(z.object({ userId: z.string(), name: z.string().nullable(), email: z.string().nullable() })),
  })),
  unresolvedSteps: z.array(z.number().int()),
  hypotheticalContext: z.record(z.string(), z.unknown()).optional(),
});
export const simulatePayrollImpactResponseSchema = z.object({
  simulation: z.string(),
  currentGross: z.number(),
  hypotheticalComponents: z.array(z.object({ type: z.string(), amount: z.number() })),
  totalEarningsDelta: z.number(),
  totalDeductionsDelta: z.number(),
  projectedGross: z.number(),
  effectiveDate: z.string(),
});
export const compareSimulationResponseSchema = z.object({
  simulation: z.string(),
  employeeId: z.string(),
  policyType: z.string(),
  oldPolicyId: z.string().nullable().optional(),
  newPolicyId: z.string().nullable().optional(),
  resolvedOldPolicy: z.record(z.string(), z.unknown()).nullable(),
  resolvedNewPolicy: z.record(z.string(), z.unknown()).nullable(),
});

export const getEventStreamMetricDefinitionsResponseSchema = z.object({
  metrics: z.array(z.object({
    name: z.string(),
    description: z.string(),
    aggregation: z.string(),
  })),
});
