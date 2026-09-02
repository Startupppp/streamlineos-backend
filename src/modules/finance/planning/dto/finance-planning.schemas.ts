import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const listBudgetsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "ARCHIVED"]).optional(),
  fiscalYear: z.string().max(10).optional(),
}).strict();
export type ListBudgetsQuery = z.infer<typeof listBudgetsQuerySchema>;

export const createBudgetSchema = z.object({
  name: z.string().min(1).max(200),
  fiscalYear: z.string().min(4).max(10),
  periodType: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).default("MONTHLY"),
  dimensionType: z.enum(["NONE", "DEPARTMENT", "PROJECT"]).default("NONE"),
}).strict();
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

export const updateBudgetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  dimensionType: z.enum(["NONE", "DEPARTMENT", "PROJECT"]).optional(),
}).strict();
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

export const budgetLineSchema = z.object({
  accountId: z.number().int().positive(),
  periodKey: z.string().min(1).max(20),
  amount: z.number().nonnegative(),
  departmentId: z.string().uuid().optional(),
  projectId: z.number().int().positive().optional(),
});

export const replaceBudgetLinesSchema = z.object({
  lines: z.array(budgetLineSchema).max(5000),
  note: z.string().max(500).optional(),
}).strict();
export type ReplaceBudgetLinesInput = z.infer<typeof replaceBudgetLinesSchema>;

export const budgetWorkflowSchema = z.object({
  note: z.string().max(500).optional(),
}).strict();
export type BudgetWorkflowInput = z.infer<typeof budgetWorkflowSchema>;

export const duplicateBudgetSchema = z.object({
  newFiscalYear: z.string().min(4).max(10),
  newName: z.string().min(1).max(200),
  upliftPct: z.number().min(-100).max(200).default(0),
}).strict();
export type DuplicateBudgetInput = z.infer<typeof duplicateBudgetSchema>;

export const bvaQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
}).strict();
export type BvaQuery = z.infer<typeof bvaQuerySchema>;

export const forecastQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(52).default(13),
  scenarioId: z.coerce.number().int().positive().optional(),
}).strict();
export type ForecastQuery = z.infer<typeof forecastQuerySchema>;

export const compareScenariosQuerySchema = z.object({
  scenarioIds: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map(Number) : v),
    z.array(z.number().int().positive()).min(2).max(5),
  ),
}).strict();
export type CompareScenariosQuery = z.infer<typeof compareScenariosQuerySchema>;

export const plannedSpendItemSchema = z.object({
  label: z.string().min(1).max(100),
  amount: z.number().nonnegative(),
  startWeek: z.number().int().min(0).max(51),
  recurringWeekly: z.boolean().default(false),
});

export const scenarioAssumptionsSchema = z.object({
  collectionRatePct: z.number().min(0).max(100).default(90),
  payDelayDays: z.number().int().min(0).max(90).default(0),
  revenueGrowthPct: z.number().min(-100).max(500).default(0),
  plannedSpend: z.array(plannedSpendItemSchema).max(100).default([]),
});
export type ScenarioAssumptions = z.infer<typeof scenarioAssumptionsSchema>;

export const createScenarioSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(["CONSERVATIVE", "EXPECTED", "AGGRESSIVE", "CUSTOM"]).default("CUSTOM"),
  isDefault: z.boolean().default(false),
  assumptions: scenarioAssumptionsSchema.optional(),
}).strict();
export type CreateScenarioInput = z.infer<typeof createScenarioSchema>;

export const updateScenarioSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isDefault: z.boolean().optional(),
  assumptions: scenarioAssumptionsSchema.optional(),
}).strict();
export type UpdateScenarioInput = z.infer<typeof updateScenarioSchema>;
