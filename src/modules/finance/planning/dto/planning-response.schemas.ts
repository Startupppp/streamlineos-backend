import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const budgetListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  fiscalYear: z.string(),
  periodType: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]),
  dimensionType: z.enum(["NONE", "DEPARTMENT", "PROJECT"]).nullable(),
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "ARCHIVED"]),
  totalAmount: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const budgetListResponseSchema = cursorPageSchema(budgetListItemSchema);

const budgetLineSchema = z.object({
  accountId: z.number().int(),
  accountCode: z.string(),
  accountName: z.string(),
  periodKey: z.string(),
  amount: z.string(),
  departmentId: z.string().nullable(),
  projectId: z.number().int().nullable(),
});

export const budgetDetailResponseSchema = budgetListItemSchema.extend({
  lines: z.array(budgetLineSchema),
});

export const budgetWorkflowResponseSchema = budgetListItemSchema;

export const budgetRevisionListResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    revisionNumber: z.number().int(),
    note: z.string().nullable(),
    createdBy: z.string(),
    createdAt: wireDate(),
    lineCount: z.number().int(),
  }),
);

export const budgetSeedDefaultsResponseSchema = z.object({
  created: z.number().int(),
});

export const scenarioSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  kind: z.enum(["CONSERVATIVE", "EXPECTED", "AGGRESSIVE", "CUSTOM"]),
  assumptions: z.unknown().nullable(),
  isDefault: z.boolean(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const scenarioListResponseSchema = z.array(scenarioSchema);

const bvaAccountPeriodRowSchema = z.object({
  accountId: z.number().int(),
  accountCode: z.string(),
  accountName: z.string(),
  periodKey: z.string(),
  budgeted: z.string(),
  actual: z.string(),
  variance: z.string(),
  variancePct: z.string(),
  exceeded: z.boolean(),
});

export const bvaResponseSchema = z.object({
  budgetId: z.number().int(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  rows: z.array(bvaAccountPeriodRowSchema),
  totals: z.object({
    budgeted: z.string(),
    actual: z.string(),
    variance: z.string(),
    variancePct: z.string(),
  }),
});

const forecastWeekSchema = z.object({
  weekIndex: z.number().int(),
  weekStart: z.string(),
  weekEnd: z.string(),
  openingCash: z.string(),
  inflows: z.string(),
  outflows: z.string(),
  net: z.string(),
  closingCash: z.string(),
  minimumBalanceWarning: z.boolean(),
});

export const forecastResponseSchema = z.object({
  scenarioId: z.number().int().nullable(),
  generatedAt: z.string(),
  weeks: z.array(forecastWeekSchema),
  totalInflows: z.string(),
  totalOutflows: z.string(),
});

const compareRowSchema = z.object({
  weekIndex: z.number().int(),
  weekStart: z.string(),
  closingCash: z.record(z.string(), z.string()),
});

export const scenarioCompareResponseSchema = z.object({
  scenarioIds: z.array(z.number().int()),
  scenarios: z.array(z.object({ id: z.number().int(), name: z.string(), kind: z.string() })),
  weeks: z.array(compareRowSchema),
});
