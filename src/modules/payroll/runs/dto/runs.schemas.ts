import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const runTypeSchema = z.enum([
  "REGULAR",
  "BONUS",
  "OFF_CYCLE",
  "CORRECTION",
  "FINAL_SETTLEMENT",
]);

export const createRunSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/, "Month must be YYYY-MM"),
    runType: runTypeSchema.default("REGULAR"),
    sourcePeriodKey: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    sourceRunId: z.number().int().positive().optional(),
    entityId: z.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    if (
      (val.runType === "OFF_CYCLE" ||
        val.runType === "CORRECTION" ||
        val.runType === "FINAL_SETTLEMENT") &&
      !val.sourcePeriodKey &&
      !val.sourceRunId
    ) {
      ctx.addIssue({
        code: "custom",
        message: "sourcePeriodKey or sourceRunId is required for off-cycle, correction, and F&F runs",
        path: ["sourcePeriodKey"],
      });
    }
  });
export type CreateRunInput = z.infer<typeof createRunSchema>;

const RUNS_LIST_CAP = 100;
const EMPLOYEES_LIST_CAP = 100;

export const listRunsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(RUNS_LIST_CAP).optional().default(20),
  entityId: z.coerce.number().int().positive().optional(),
}).strict();
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const listRunEmployeesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(EMPLOYEES_LIST_CAP).optional().default(20),
  search: z.string().optional(),
  status: z.string().optional(),
  workerType: z.string().optional(),
}).strict();
export type ListRunEmployeesQuery = z.infer<typeof listRunEmployeesQuerySchema>;

export const exportRunsQuerySchema = z.object({
  entityId: z.coerce.number().int().positive().optional(),
  monthFrom: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  monthTo: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  runType: z.enum(["REGULAR", "BONUS", "OFF_CYCLE", "CORRECTION", "FINAL_SETTLEMENT"]).optional(),
}).strict();
export type ExportRunsQuery = z.infer<typeof exportRunsQuerySchema>;

export const patchInputSchema = z.object({
  scheduledDays: z.string().optional(),
  paidDays: z.string().optional(),
  lopDays: z.string().optional(),
  overtimeHours: z.string().optional(),
  billableHours: z.string().optional(),
  reason: z.string().min(1).max(500),
});
export type PatchInputInput = z.infer<typeof patchInputSchema>;

export const resolveExceptionSchema = z.object({
  note: z.string().max(500).optional(),
});
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;

export const overrideExceptionSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type OverrideExceptionInput = z.infer<typeof overrideExceptionSchema>;

export const setEmployeeHoldSchema = z.object({
  hold: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type SetEmployeeHoldInput = z.infer<typeof setEmployeeHoldSchema>;

export const addRunAdjustmentSchema = z.object({
  type: z.enum(["EARNING", "DEDUCTION"]),
  name: z.string().min(1).max(100),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a positive decimal string"),
  note: z.string().min(1).max(500),
});
export type AddRunAdjustmentInput = z.infer<typeof addRunAdjustmentSchema>;

export const loanAdjustmentSchema = z.object({
  loanId: z.number().int().positive(),
  type: z.enum(["SKIP_EMI", "EXTRA_RECOVERY", "FORECLOSURE", "MANUAL_ADJUST"]),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  reason: z.string().min(1).max(500),
});
export type LoanAdjustmentInput = z.infer<typeof loanAdjustmentSchema>;

export const commandCenterQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
export type CommandCenterQuery = z.infer<typeof commandCenterQuerySchema>;

export const listProfilesQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(20, 100),
  search: z.string().optional(),
  workerType: z.enum(["EMPLOYEE", "CONTRACTOR", "CONSULTANT", "INTERN", "EOR"]).optional(),
  status: z.enum(["UPCOMING", "ACTIVE", "SUPERSEDED"]).optional(),
  costCenter: z.string().optional(),
});
export type ListProfilesQuery = z.infer<typeof listProfilesQuerySchema>;

export const createProfileSchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  annualCtc: z.string().regex(/^\d+(\.\d{1,2})?$/),
  workerType: z.enum(["EMPLOYEE", "CONTRACTOR", "CONSULTANT", "INTERN", "EOR"]).optional().default("EMPLOYEE"),
  currency: z.string().length(3).optional().default("INR"),
  payoutCurrency: z.string().length(3).optional(),
  taxRegime: z.enum(["OLD", "NEW"]).optional(),
  costCenter: z.string().max(100).optional(),
  components: z.array(z.object({
    componentId: z.number().int().positive(),
    calcMethodOverride: z.enum(["FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FORMULA", "ATTENDANCE_BASED", "TIMESHEET_BASED", "MANUAL"]).optional(),
    amount: z.string().optional(),
    percent: z.string().optional(),
    formulaOverride: z.string().max(500).optional(),
  })).optional().default([]),
});
export type CreateProfileInput = z.infer<typeof createProfileSchema>;

export const patchProfileSchema = createProfileSchema.partial().omit({ effectiveFrom: true });
export type PatchProfileInput = z.infer<typeof patchProfileSchema>;

export const inputsQuerySchema = z.object({
  userId: z.string().optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(50, 100),
});
export type InputsQuery = z.infer<typeof inputsQuerySchema>;

export const exceptionFilterSchema = z.object({
  severity: z.enum(["BLOCKER", "WARNING", "INFO"]).optional(),
  status: z.enum(["OPEN", "RESOLVED", "OVERRIDDEN"]).optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(50, 100),
});
export type ExceptionFilterInput = z.infer<typeof exceptionFilterSchema>;
