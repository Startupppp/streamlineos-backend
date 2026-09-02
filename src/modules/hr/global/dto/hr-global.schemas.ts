import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const createWorkAuthSchema = z.object({
  employmentId: z.number().int().positive(),
  authType: z.enum(["work_permit", "visa", "right_to_work", "citizenship_proof", "other"]),
  countryCode: z.string().min(2).max(3).toUpperCase(),
  documentNumberMasked: z.string().max(20).optional(),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  status: z.enum(["active", "expiring", "expired", "pending_renewal"]).default("active"),
  note: z.string().max(1000).optional(),
}).strict();

export const updateWorkAuthSchema = createWorkAuthSchema.partial().omit({ employmentId: true }).strict();

export const listWorkAuthSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  employmentId: z.coerce.number().int().positive().optional(),
  status: z.enum(["active", "expiring", "expired", "pending_renewal"]).optional(),
  days: z.coerce.number().int().positive().optional(),
}).strict();

export const createComplianceRequirementSchema = z.object({
  name: z.string().min(1).max(200),
  countryCode: z.string().max(3).optional(),
  stateCode: z.string().max(10).optional(),
  category: z.enum(["statutory_filing", "registration", "posting", "training", "audit", "other"]),
  frequency: z.enum(["once", "monthly", "quarterly", "yearly"]),
  dueRule: z.object({
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
    offsetDays: z.number().int().min(0).optional(),
  }),
  reminderDaysBefore: z.number().int().min(0).max(365).default(7),
  active: z.boolean().default(true),
}).strict();

export const updateComplianceRequirementSchema = createComplianceRequirementSchema.partial().strict();

export const listComplianceRequirementSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  countryCode: z.string().optional(),
  category: z.enum(["statutory_filing", "registration", "posting", "training", "audit", "other"]).optional(),
  active: queryBoolean.optional(),
}).strict();

export const listComplianceEventsSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  requirementId: z.coerce.number().int().positive().optional(),
  status: z.enum(["pending", "done", "overdue"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
}).strict();

export const markEventDoneSchema = z.object({
  notes: z.string().max(2000).optional(),
}).strict();

export const seedCountryPackSchema = z.object({
  country: z.string().min(2).max(10),
  year: z.coerce.number().int().min(2020).max(2040).optional(),
}).strict();

export const createContractSchema = z.object({
  employmentId: z.number().int().positive(),
  contractType: z.enum(["contractor", "consultant", "intern", "temporary", "agency", "freelancer"]),
  agencyVendor: z.string().max(200).optional(),
  startDate: z.string(),
  endDate: z.string().optional(),
  renewalReminderDays: z.number().int().min(0).max(365).default(30),
  stipendCents: z.number().int().min(0).optional(),
  timesheetBased: z.boolean().default(false),
  status: z.enum(["active", "expiring", "ended", "renewed", "converted"]).default("active"),
  documentUrl: z.string().url().optional(),
}).strict();

export const updateContractSchema = createContractSchema.partial().omit({ employmentId: true }).strict();

export const listContractsSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  contractType: z.enum(["contractor", "consultant", "intern", "temporary", "agency", "freelancer"]).optional(),
  status: z.enum(["active", "expiring", "ended", "renewed", "converted"]).optional(),
  days: z.coerce.number().int().positive().optional(),
}).strict();

export const endContractSchema = z.object({
  notes: z.string().max(2000).optional(),
}).strict();

export const convertToEmployeeSchema = z.object({
  effectiveDate: z.string().optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export type CreateWorkAuthInput = z.infer<typeof createWorkAuthSchema>;
export type UpdateWorkAuthInput = z.infer<typeof updateWorkAuthSchema>;
export type ListWorkAuthInput = z.infer<typeof listWorkAuthSchema>;
export type CreateComplianceRequirementInput = z.infer<typeof createComplianceRequirementSchema>;
export type UpdateComplianceRequirementInput = z.infer<typeof updateComplianceRequirementSchema>;
export type ListComplianceRequirementInput = z.infer<typeof listComplianceRequirementSchema>;
export type ListComplianceEventsInput = z.infer<typeof listComplianceEventsSchema>;
export type MarkEventDoneInput = z.infer<typeof markEventDoneSchema>;
export type SeedCountryPackInput = z.infer<typeof seedCountryPackSchema>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractInput = z.infer<typeof updateContractSchema>;
export type ListContractsInput = z.infer<typeof listContractsSchema>;
export type EndContractInput = z.infer<typeof endContractSchema>;
export type ConvertToEmployeeInput = z.infer<typeof convertToEmployeeSchema>;
