import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema, cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const complianceRequirementSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  countryCode: z.string().nullable(),
  stateCode: z.string().nullable(),
  category: z.enum(["statutory_filing", "registration", "posting", "training", "audit", "other"]),
  frequency: z.enum(["once", "monthly", "quarterly", "yearly"]),
  dueRule: z.object({ month: z.number().int().optional(), day: z.number().int().optional(), offsetDays: z.number().int().optional() }),
  reminderDaysBefore: z.number().int(),
  active: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const complianceEventSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  requirementId: z.number().int(),
  dueDate: z.string(),
  status: z.enum(["pending", "done", "overdue"]),
  completedBy: z.string().nullable(),
  completedAt: nullableWireDate(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const complianceEventWithRequirementSchema = complianceEventSchema.extend({
  requirementName: z.string().nullable(),
  category: z.string().nullable(),
  reminderDaysBefore: z.number().int().nullable(),
});

export const listComplianceRequirementsResponseSchema = cursorPageSchema(complianceRequirementSchema);
export const getComplianceRequirementResponseSchema = complianceRequirementSchema;
export const createComplianceRequirementResponseSchema = complianceRequirementSchema;
export const updateComplianceRequirementResponseSchema = complianceRequirementSchema;
export const deleteComplianceRequirementResponseSchema = z.object({ ok: z.literal(true) });

export const listComplianceEventsResponseSchema = z.object({
  data: z.array(complianceEventWithRequirementSchema),
  pagination: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const markEventDoneResponseSchema = complianceEventSchema;

export const generateEventsResponseSchema = z.object({
  generated: z.number().int(),
  total: z.number().int(),
});

export const seedCountryPackResponseSchema = z.object({
  country: z.string(),
  holidays: z.number().int(),
  requirements: z.number().int(),
  sensitiveFieldKeys: z.array(z.string()),
});

const contractSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  employmentId: z.number().int(),
  contractType: z.enum(["contractor", "consultant", "intern", "temporary", "agency", "freelancer"]),
  agencyVendor: z.string().nullable(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  renewalReminderDays: z.number().int(),
  stipendCents: z.number().int().nullable(),
  timesheetBased: z.boolean(),
  status: z.enum(["active", "expiring", "ended", "renewed", "converted"]),
  documentUrl: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const listContractsResponseSchema = cursorPageSchema(contractSchema);
export const getContractResponseSchema = contractSchema;
export const createContractResponseSchema = contractSchema;
export const updateContractResponseSchema = contractSchema;
export const endContractResponseSchema = contractSchema;
export const listExpiringContractsResponseSchema = cursorPageSchema(contractSchema);
export const renewContractResponseSchema = contractSchema;

const workAuthSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  employmentId: z.number().int(),
  authType: z.enum(["work_permit", "visa", "right_to_work", "citizenship_proof", "other"]),
  countryCode: z.string(),
  documentNumberMasked: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  status: z.enum(["active", "expiring", "expired", "pending_renewal"]),
  verifiedBy: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const listWorkAuthsResponseSchema = cursorPageSchema(workAuthSchema);
export const getWorkAuthResponseSchema = workAuthSchema;
export const createWorkAuthResponseSchema = workAuthSchema;
export const updateWorkAuthResponseSchema = workAuthSchema;
export const listExpiringWorkAuthsResponseSchema = cursorPageSchema(workAuthSchema);

export const convertToEmployeeResponseSchema = z.object({ ok: z.literal(true), employmentId: z.number().int().nullable() });
export const internshipCertificateResponseSchema = z.object({ html: z.string(), templateId: z.number().int().nullable() });
export const removeWorkAuthResponseSchema = z.object({ ok: z.literal(true) });
