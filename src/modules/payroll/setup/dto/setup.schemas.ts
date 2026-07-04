import { z } from "zod";
import { PAYROLL_TOGGLE_KEYS, PAYROLL_TEMPLATE_KEYS } from "../../payroll.types";

export const toggleOverridesSchema = z
  .record(z.string(), z.boolean())
  .optional();

export const listTemplatesSchema = z.object({
  category: z.string().trim().optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListTemplatesInput = z.infer<typeof listTemplatesSchema>;

export const templatePreviewSchema = z.object({
  annualCtc: z.coerce.number().positive().max(1_000_000_000),
  toggleOverrides: toggleOverridesSchema,
});
export type TemplatePreviewInput = z.infer<typeof templatePreviewSchema>;

export const duplicateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
});
export type DuplicateTemplateInput = z.infer<typeof duplicateTemplateSchema>;

export const createPolicySchema = z.object({
  country: z.string().trim().min(1).max(10).default("IN"),
  state: z.string().trim().max(50).optional(),
  legalEntityName: z.string().trim().max(200).optional(),
  currency: z.string().trim().length(3).default("INR"),
  payFrequency: z.enum(["MONTHLY", "SEMI_MONTHLY", "BI_WEEKLY", "WEEKLY"]).default("MONTHLY"),
  payDay: z.coerce.number().int().min(1).max(31).default(28),
  startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "startMonth must be YYYY-MM"),
});
export type CreatePolicyInput = z.infer<typeof createPolicySchema>;

export const updatePolicySchema = z.object({
  country: z.string().trim().min(1).max(10).optional(),
  state: z.string().trim().max(50).optional(),
  legalEntityName: z.string().trim().max(200).optional(),
  currency: z.string().trim().length(3).optional(),
  payFrequency: z.enum(["MONTHLY", "SEMI_MONTHLY", "BI_WEEKLY", "WEEKLY"]).optional(),
  payDay: z.coerce.number().int().min(1).max(31).optional(),
  startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

export const policyPreviewSchema = z.object({
  templateKey: z.enum(PAYROLL_TEMPLATE_KEYS).optional(),
  templateId: z.coerce.number().int().positive().optional(),
  toggleOverrides: toggleOverridesSchema,
  country: z.string().trim().max(10).optional(),
  currency: z.string().trim().length(3).optional(),
  payDay: z.coerce.number().int().min(1).max(31).optional(),
  startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});
export type PolicyPreviewInput = z.infer<typeof policyPreviewSchema>;

const calendarSchema = z.object({
  attendanceCutoffDay: z.coerce.number().int().min(1).max(31).default(20),
  reimbursementCutoffDay: z.coerce.number().int().min(1).max(31).default(20),
  declarationCutoffDay: z.coerce.number().int().min(1).max(31).default(15),
  previewDay: z.coerce.number().int().min(1).max(31).default(22),
  approvalDeadlineDay: z.coerce.number().int().min(1).max(31).default(25),
  publishOffsetDays: z.coerce.number().int().min(0).max(7).default(1),
});

const statutorySchema = z.object({
  pfEmployeePercent: z.string().default("12"),
  pfEmployerPercent: z.string().default("12"),
  pfWageCeiling: z.string().nullable().default("15000.00"),
  esiEmployeePercent: z.string().default("0.75"),
  esiEmployerPercent: z.string().default("3.25"),
  esiWageCeiling: z.string().nullable().default("21000.00"),
  professionalTaxMonthly: z.string().default("200.00"),
  tdsMode: z.enum(["DECLARATION", "FLAT", "NONE"]).default("DECLARATION"),
  tdsFlatPercent: z.string().nullable().default(null),
});

export const activatePolicySchema = z.object({
  templateKey: z.enum(PAYROLL_TEMPLATE_KEYS).optional(),
  templateId: z.coerce.number().int().positive().optional(),
  toggleOverrides: toggleOverridesSchema,
  payslipLayout: z.enum(["CLASSIC", "MODERN", "COMPLIANCE"]).default("CLASSIC"),
  calendar: calendarSchema.optional(),
  statutory: statutorySchema.optional(),
  reason: z.string().trim().max(500).optional(),
});
export type ActivatePolicyInput = z.infer<typeof activatePolicySchema>;

export type ActivateCalendarInput = z.infer<typeof calendarSchema>;
export type ActivateStatutoryInput = z.infer<typeof statutorySchema>;

export const createPolicyVersionSchema = z.object({
  toggleOverrides: toggleOverridesSchema,
  config: z.record(z.string(), z.unknown()).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "effectiveFrom must be YYYY-MM-DD"),
  reason: z.string().trim().min(1).max(500),
});
export type CreatePolicyVersionInput = z.infer<typeof createPolicyVersionSchema>;

export const listComponentsSchema = z.object({
  type: z.string().trim().optional(),
  active: z.coerce.boolean().optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListComponentsInput = z.infer<typeof listComponentsSchema>;

export const createComponentSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(30)
    .regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, digits, or underscores"),
  name: z.string().trim().min(1).max(100),
  type: z.enum(["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "TAX", "ADJUSTMENT"]),
  calcMethod: z.enum(["FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FORMULA", "ATTENDANCE_BASED", "TIMESHEET_BASED", "MANUAL"]),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  percent: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  formula: z.string().trim().max(500).optional(),
  taxable: z.boolean().default(false),
  showOnPayslip: z.boolean().default(true),
  includeInCtc: z.boolean().default(true),
  isStatutory: z.boolean().default(false),
  statutoryKey: z.string().trim().max(50).optional(),
  sortOrder: z.coerce.number().int().min(0).default(0),
});
export type CreateComponentInput = z.infer<typeof createComponentSchema>;

export const updateComponentSchema = createComponentSchema.omit({ code: true }).partial();
export type UpdateComponentInput = z.infer<typeof updateComponentSchema>;

export const toggleImpactSchema = z.object({
  toggle: z.enum(PAYROLL_TOGGLE_KEYS),
});
export type ToggleImpactInput = z.infer<typeof toggleImpactSchema>;
