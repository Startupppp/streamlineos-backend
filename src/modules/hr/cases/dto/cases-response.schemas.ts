import { z } from "zod";
import { hrSafetyIncidentTypeEnum, hrSafetyIncidentSeverityEnum, hrSafetyIncidentStatusEnum } from "../../../../db/schema/hr/safety";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const hrCaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  caseNumber: z.string(),
  category: z.string(),
  subjectEmployeeId: z.string().nullable(),
  reportedBy: z.string().nullable(),
  anonymous: z.boolean(),
  confidential: z.boolean(),
  severity: z.string(),
  status: z.string(),
  summary: z.string(),
  details: z.string(),
  outcome: z.string().nullable(),
  resolvedAt: nullableWireDate(),
  assignedTo: z.string().nullable(),
  assignedToMembershipId: z.number().int().nullable(),
  reportedByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const hrCaseListSchema = cursorPageSchema(hrCaseSchema);

export const hrCaseStatsItemSchema = z.object({
  status: z.string().nullable(),
  total: z.number().int(),
});

export const hrCaseNoteSchema = z.object({
  id: z.number().int(),
  caseId: z.number().int(),
  orgId: z.string(),
  authorId: z.string().nullable(),
  authorMembershipId: z.number().int().nullable(),
  note: z.string(),
  isConfidential: z.boolean(),
  createdAt: wireDate(),
});

export const hrCaseDocumentSchema = z.object({
  id: z.number().int(),
  caseId: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  url: z.string(),
  restricted: z.boolean(),
  uploadedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const anonymousCaseResponseSchema = z.object({
  caseNumber: z.string(),
});

export const hrDisciplinaryActionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  caseId: z.number().int().nullable(),
  employeeId: z.string(),
  employeeMembershipId: z.number().int().nullable(),
  actionType: z.string(),
  letterRenderId: z.number().int().nullable(),
  effectiveDate: wireDate(),
  issuedBy: z.string(),
  note: z.string().nullable(),
  acknowledgedAt: nullableWireDate(),
  acknowledgedBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const hrDisciplinaryCreateResponseSchema = hrDisciplinaryActionSchema.extend({
  progressive: z.object({
    warning: z.string().nullable(),
    honestyNote: z.string().nullable(),
  }),
});

export const hrDisciplinaryListSchema = cursorPageSchema(hrDisciplinaryActionSchema);

export const unacknowledgedCountSchema = z.object({
  unacknowledged: z.number().int(),
});

export const hrSafetyIncidentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  incidentNumber: z.string(),
  type: z.enum(hrSafetyIncidentTypeEnum.enumValues),
  location: z.string(),
  occurredAt: wireDate(),
  reportedBy: z.string(),
  description: z.string(),
  severity: z.enum(hrSafetyIncidentSeverityEnum.enumValues),
  status: z.enum(hrSafetyIncidentStatusEnum.enumValues),
  medicalAttention: z.boolean(),
  confidentialMedicalNote: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const hrSafetyIncidentListSchema = cursorPageSchema(hrSafetyIncidentSchema);

export const hrWellnessCheckinSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  date: z.string(),
  score: z.number().int(),
  flags: z.array(z.string()).nullable(),
  createdAt: wireDate(),
});

export const serviceDeliveryItemSchema = z.object({
  kind: z.enum(["case", "safety_incident", "helpdesk"]),
  id: z.number().int(),
  ref: z.string(),
  title: z.string(),
  status: z.string(),
  severity: z.string().nullable(),
  assignedTo: z.string().nullable(),
  href: z.string(),
  createdAt: z.string(),
  aging: z.object({
    ageHours: z.number(),
    ageDays: z.number(),
    bucket: z.enum(["fresh", "watch", "overdue", "critical"]),
    slaBreached: z.boolean(),
  }),
  severityRank: z.number().int(),
  confidential: z.boolean().optional(),
});

export const opsInboxResponseSchema = z.object({
  mode: z.literal("ops_unified_inbox"),
  honestyNote: z.string(),
  asOf: z.string(),
  capabilities: z.object({
    canViewCases: z.boolean(),
    canViewSafety: z.boolean(),
    canViewHelpdesk: z.boolean(),
  }),
  totals: z.object({
    cases: z.number().int(),
    safety: z.number().int(),
    helpdesk: z.number().int(),
    criticalAging: z.number().int(),
    slaBreached: z.number().int(),
  }),
  items: z.array(serviceDeliveryItemSchema),
});

export const myItemsResponseSchema = z.object({
  mode: z.literal("employee_self_service"),
  honestyNote: z.string(),
  items: z.array(serviceDeliveryItemSchema),
  totals: z.object({ open: z.number().int() }),
});

export const wellnessTrendItemSchema = z.object({
  date: z.string(),
  avgScore: z.number().nullable(),
  respondents: z.number().int().nullable(),
});

export const wellnessTrendListSchema = z.array(wellnessTrendItemSchema);

export const burnoutFlagItemSchema = z.object({
  userId: z.string(),
  avgScore: z.number(),
  checkCount: z.number().int(),
});

export const burnoutFlagListSchema = z.array(burnoutFlagItemSchema);

export const wellnessPulseSchema = z.object({
  mode: z.literal("k_anonymized_pulse"),
  honestyNote: z.string(),
  windowDays: z.number().int(),
  minGroupSize: z.number().int(),
  suppressed: z.boolean(),
  respondents: z.number().int().nullable(),
  avgScore: z.number().nullable(),
  checkins: z.number().int().nullable(),
  burnoutThreshold: z.number().int(),
});

export { successSchema };
