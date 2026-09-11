import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const headcountPlanSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  fiscalYear: z.number().int(),
  departmentId: z.string().nullable(),
  budgetedHeadcount: z.number().int(),
  budgetedCostCents: z.number().int().nullable(),
  note: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const workforcePlanProjectionSchema = z.object({
  id: z.number().int(),
  fiscalYear: z.number().int(),
  departmentId: z.string().nullable(),
  departmentName: z.string().nullable(),
  budgetedHeadcount: z.number().int(),
  budgetedCostCents: z.number().int().nullable(),
  note: z.string().nullable(),
  createdAt: wireDate(),
});

export const getWorkforcePlansResponseSchema = z.array(workforcePlanProjectionSchema);

export const createHeadcountPlanResponseSchema = z.array(headcountPlanSchema);

export const updateHeadcountPlanResponseSchema = headcountPlanSchema;

export const getMetricDefinitionsResponseSchema = z.array(z.object({ name: z.string(), formula: z.string(), source: z.string() }));

export const getCommandCenterResponseSchema = z.object({
  headcount: z.object({
    total: z.number().int(),
    active: z.number().int(),
    probation: z.number().int(),
    notice: z.number().int(),
  }),
  attritionRate12mo: z.number(),
  avgTenureMonths: z.number(),
  leaveUtilizationPct: z.number(),
  attendanceRatePct: z.number(),
  openCasesCount: z.number().int(),
  avgMood: z.number().nullable(),
  payrollCostLastMonth: z.number().nullable(),
});

export const getAttritionResponseSchema = z.object({
  joinsVsExits: z.array(z.object({ month: z.string(), joins: z.number().int(), exits: z.number().int() })),
  byDepartment: z.array(z.object({ department: z.string(), exits: z.number().int() })),
  byReason: z.array(z.object({ reason: z.string(), count: z.number().int() })),
});

export const getLeaveTrendsResponseSchema = z.object({
  trends: z.array(z.object({ month: z.unknown().nullable(), leave_type: z.unknown().nullable(), days: z.unknown().nullable() })),
});

export const getPayrollCostResponseSchema = z.object({
  monthly: z.array(z.object({ month: z.string(), grossTotal: z.number() })),
});

export const getEngagementResponseSchema = z.object({
  moodByMonth: z.array(z.object({ month: z.string(), avgMood: z.number() })),
});

export const getPerformanceDistResponseSchema = z.object({
  distribution: z.array(z.object({ rating: z.number(), count: z.number().int() })),
});

export const getComplianceGapsResponseSchema = z.object({
  openCases: z.array(z.object({ category: z.string(), count: z.number().int() })),
});

export const getDrilldownResponseSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const getBudgetVsActualResponseSchema = z.array(z.object({
  planId: z.number().int(),
  fiscalYear: z.number().int(),
  departmentId: z.string().nullable(),
  departmentName: z.string(),
  budgeted: z.number().int(),
  actual: z.number().int(),
  variance: z.number().int(),
}));

export const getSkillsGapResponseSchema = z.object({
  gaps: z.array(z.object({
    skillName: z.string(),
    required: z.number().int(),
    covered: z.number().int(),
    gap: z.number().int(),
  })),
});

export const getSuccessionRiskResponseSchema = z.object({
  riskyRoles: z.array(z.object({
    id: z.number().int(),
    roleName: z.string(),
    incumbentId: z.string().nullable(),
    readiness: z.string().nullable(),
    hasSuccessor: z.boolean(),
    note: z.string().nullable(),
  })),
});

export const getAttritionForecastResponseSchema = z.object({
  historical: z.array(z.object({ month: z.string(), exits: z.number().int(), rate: z.number() })),
  forecast: z.array(z.object({ month: z.string(), projectedExits: z.number(), projectedRate: z.number() })),
  disclaimer: z.string(),
});
