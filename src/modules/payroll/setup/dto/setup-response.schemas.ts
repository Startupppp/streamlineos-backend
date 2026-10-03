import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const salaryComponentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.enum(["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "TAX", "ADJUSTMENT"]),
  calcMethod: z.enum(["FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FORMULA", "ATTENDANCE_BASED", "TIMESHEET_BASED", "MANUAL"]),
  amount: z.string().nullable(),
  percent: z.string().nullable(),
  formula: z.string().nullable(),
  taxable: z.boolean(),
  showOnPayslip: z.boolean(),
  includeInCtc: z.boolean(),
  isStatutory: z.boolean(),
  statutoryKey: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const componentListPaginationSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const componentListResponseSchema = z.object({
  items: z.array(salaryComponentSchema),
  pagination: componentListPaginationSchema,
});

const salaryPreviewTotalsSchema = z.object({
  gross: z.string(),
  deductions: z.string(),
  employerContributions: z.string(),
  net: z.string(),
});

export const salaryPreviewResponseSchema = z.object({
  annualCtc: z.string(),
  month: z.string(),
  regime: z.enum(["OLD", "NEW"]),
  stateCode: z.string().nullable(),
  lines: z.array(z.object({
    code: z.string(),
    name: z.string(),
    category: z.enum(["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "TAX", "ADJUSTMENT"]),
    taxable: z.boolean(),
    monthly: z.string(),
    annual: z.string(),
    note: z.string().nullable(),
  })),
  monthly: salaryPreviewTotalsSchema,
  annual: salaryPreviewTotalsSchema,
  warnings: z.array(z.string()),
});
