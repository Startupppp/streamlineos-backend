import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema, cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const proxyAccessSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  grantorUserId: z.string(),
  grantorMembershipId: z.number().int().nullable(),
  proxyUserId: z.string(),
  proxyMembershipId: z.number().int().nullable(),
  scope: z.enum(["approvals", "hr_admin", "manager_tasks"]),
  startsAt: wireDate(),
  endsAt: wireDate(),
  reason: z.string().nullable(),
  active: z.boolean(),
  disallowSensitive: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listProxiesResponseSchema = cursorPageSchema(proxyAccessSchema);
export const createProxyResponseSchema = proxyAccessSchema;
export const updateProxyResponseSchema = proxyAccessSchema;

const unionMembershipSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  unionName: z.string(),
  memberSince: wireDate(),
  status: z.enum(["active", "inactive"]),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listUnionMembershipsResponseSchema = cursorPageSchema(unionMembershipSchema);
export const createUnionMembershipResponseSchema = unionMembershipSchema;
export const updateUnionMembershipResponseSchema = unionMembershipSchema;

const collectiveAgreementSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  unionName: z.string(),
  title: z.string(),
  effectiveFrom: wireDate(),
  expiresAt: nullableWireDate(),
  documentUrl: z.string().nullable(),
  status: z.enum(["active", "expired", "negotiating"]),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listAgreementsResponseSchema = cursorPageSchema(collectiveAgreementSchema);
export const listExpiringAgreementsResponseSchema = z.array(collectiveAgreementSchema);
export const createAgreementResponseSchema = collectiveAgreementSchema;
export const updateAgreementResponseSchema = collectiveAgreementSchema;

const laborCaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  unionName: z.string(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(["open", "in_review", "resolved"]),
  createdBy: z.string().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listLaborCasesResponseSchema = cursorPageSchema(laborCaseSchema);
export const createLaborCaseResponseSchema = laborCaseSchema;
export const updateLaborCaseResponseSchema = laborCaseSchema;

const legalHoldSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  subjectUserId: z.string().nullable(),
  subjectMembershipId: z.number().int().nullable(),
  reason: z.string(),
  status: z.enum(["active", "released"]),
  placedBy: z.string().nullable(),
  placedAt: wireDate(),
  releasedBy: z.string().nullable(),
  releasedAt: nullableWireDate(),
  restrictedExport: z.boolean(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const legalHoldItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  holdId: z.number().int(),
  itemType: z.enum(["employee_profile", "document", "case_evidence"]),
  itemRef: z.string(),
  locked: z.boolean(),
  createdAt: wireDate(),
});

export const listLegalHoldsResponseSchema = cursorPageSchema(legalHoldSchema);
export const getLegalHoldResponseSchema = legalHoldSchema;
export const createLegalHoldResponseSchema = legalHoldSchema;
export const updateLegalHoldResponseSchema = legalHoldSchema;
export const releaseLegalHoldResponseSchema = legalHoldSchema;

export const listLegalHoldItemsResponseSchema = z.array(legalHoldItemSchema);
export const attachHoldItemResponseSchema = legalHoldItemSchema;

const positionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  departmentId: z.string().nullable(),
  jobLevelId: z.number().int().nullable(),
  status: z.string(),
  budgetedCostCents: z.number().int().nullable(),
  effectiveFrom: wireDate(),
  incumbentUserId: z.string().nullable(),
  futureDated: z.boolean(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const reorgScenarioSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  status: z.enum(["draft", "proposed", "applied"]),
  changes: z.record(z.string(), z.unknown()),
  createdBy: z.string().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listPositionsResponseSchema = cursorPageSchema(positionSchema);
export const getPositionResponseSchema = positionSchema;
export const createPositionResponseSchema = positionSchema;
export const updatePositionResponseSchema = positionSchema;
export const assignPositionResponseSchema = positionSchema;

export const listScenariosResponseSchema = cursorPageSchema(reorgScenarioSchema);
export const createScenarioResponseSchema = reorgScenarioSchema;
export const updateScenarioResponseSchema = reorgScenarioSchema;

const retentionPolicySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  recordType: z.enum(["employee", "document", "case", "attendance", "payroll"]),
  retentionMonths: z.number().int(),
  countryCode: z.string().nullable(),
  action: z.enum(["delete", "anonymize"]),
  active: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const dataRequestSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  subjectUserId: z.string(),
  subjectMembershipId: z.number().int().nullable(),
  type: z.enum(["export", "delete", "anonymize", "correction"]),
  status: z.enum(["pending", "approved", "processing", "completed", "rejected", "partial"]),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  reason: z.string().nullable(),
  completedAt: nullableWireDate(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listRetentionPoliciesResponseSchema = cursorPageSchema(retentionPolicySchema);
export const createRetentionPolicyResponseSchema = retentionPolicySchema;
export const updateRetentionPolicyResponseSchema = retentionPolicySchema;

export const listDataRequestsResponseSchema = cursorPageSchema(dataRequestSchema);
export const createDataRequestResponseSchema = dataRequestSchema;
export const updateDataRequestResponseSchema = dataRequestSchema;
export const approveDataRequestResponseSchema = dataRequestSchema;
export const processDataRequestResponseSchema = z.union([
  z.object({ exportedAt: z.string(), subjectUserId: z.string(), orgId: z.string(), profile: z.record(z.string(), z.unknown()) }),
  z.object({ anonymized: z.literal(true), subjectUserId: z.string().optional() }),
  z.object({}),
]);

export const listVacantPositionsResponseSchema = listPositionsResponseSchema;

const positionStatusSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  order: z.number().int(),
  color: z.string().nullable(),
  lifecycleGroup: z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listStatusesResponseSchema = z.array(positionStatusSchema);
export const createStatusResponseSchema = positionStatusSchema;
export const updateStatusResponseSchema = positionStatusSchema;
export const retireStatusResponseSchema = z.object({ retired: z.literal(true) });

const positionTransitionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  fromStatusId: z.number().int().nullable(),
  toStatusId: z.number().int(),
  name: z.string().nullable(),
  requiresApproval: z.boolean(),
  requiredFields: z.array(z.string()),
  allowedRoles: z.array(z.string()),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const listTransitionsResponseSchema = z.array(positionTransitionSchema);
export const createTransitionResponseSchema = positionTransitionSchema;
export const updateTransitionResponseSchema = positionTransitionSchema;

export const simulateScenarioResponseSchema = z.object({
  scenarioId: z.number().int(),
  scenarioName: z.string(),
  status: z.string(),
  projectedEffect: z.object({
    affectedPositions: z.number().int(),
    affectedReportingLines: z.number().int(),
    positionMoves: z.array(z.unknown()),
    reportingMoves: z.array(z.unknown()),
  }),
  warning: z.string(),
});
