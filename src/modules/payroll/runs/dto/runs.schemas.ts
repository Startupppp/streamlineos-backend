import { z } from "zod";

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

export const listRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Optional legal-entity filter for multi-entity orgs. */
  entityId: z.coerce.number().int().positive().optional(),
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const listRunEmployeesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.string().optional(),
  workerType: z.string().optional(),
});
export type ListRunEmployeesQuery = z.infer<typeof listRunEmployeesQuerySchema>;

export const adjustmentSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be decimal string"),
  note: z.string().min(1).max(500),
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(100).optional(),
});

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
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  workerType: z.string().optional(),
  status: z.string().optional(),
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
});
export type InputsQuery = z.infer<typeof inputsQuerySchema>;

export const exceptionFilterSchema = z.object({
  severity: z.enum(["BLOCKER", "WARNING", "INFO"]).optional(),
  status: z.enum(["OPEN", "RESOLVED", "OVERRIDDEN"]).optional(),
});
export type ExceptionFilterInput = z.infer<typeof exceptionFilterSchema>;
