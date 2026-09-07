import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { payrollTogglesSchema } from "./policies-response.schemas";

export const payrollTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  key: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  bestFor: z.string().nullable(),
  complexity: z.string().nullable(),
  badge: z.string().nullable(),
  category: z.enum([
    "INDIAN_STANDARD", "INDIAN_STARTUP", "CONTRACTOR", "SALES_INCENTIVE",
    "GLOBAL_REMOTE", "HOURLY", "MANUFACTURING", "STAFFING", "EXECUTIVE",
    "CUSTOM", "COUNTRY_STANDARD",
  ]),
  defaultToggles: z.record(z.string(), z.unknown()),
  defaultComponents: z.array(z.unknown()),
  isSystem: z.boolean(),
  isRecommended: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const templateListPaginationSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const templateListResponseSchema = z.object({
  items: z.array(payrollTemplateRowSchema),
  pagination: templateListPaginationSchema,
});

const previewLineSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: z.enum(["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "TAX", "ADJUSTMENT"]),
  monthlyAmount: z.string(),
  calcMethod: z.enum(["FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FORMULA", "ATTENDANCE_BASED", "TIMESHEET_BASED", "MANUAL"]),
  taxable: z.boolean(),
  includeInCtc: z.boolean(),
  isStatutory: z.boolean(),
  sortOrder: z.number().int(),
  explain: z.string(),
});

export const templatePreviewResponseSchema = z.object({
  template: z.object({
    id: z.number().int(),
    key: z.string().nullable(),
    name: z.string(),
  }),
  effectiveToggles: payrollTogglesSchema,
  annualCtc: z.number(),
  monthlyCtc: z.number(),
  components: z.array(previewLineSchema),
  totals: z.object({
    grossEarnings: z.string(),
    totalDeductions: z.string(),
    employerContributions: z.string(),
    netTakeHome: z.string(),
  }),
});
