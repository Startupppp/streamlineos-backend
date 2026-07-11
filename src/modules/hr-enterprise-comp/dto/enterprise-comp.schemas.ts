import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Pack 1: Devices ─────────────────────────────────────────────────────────

export const createTimeDeviceSchema = z.object({
  name: z.string().min(1).max(200),
  serialNumber: z.string().min(1).max(100),
  type: z.enum(["biometric", "rfid", "mobile", "other"]),
  locationId: z.number().int().positive().optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
});

export const updateTimeDeviceSchema = createTimeDeviceSchema.partial().extend({
  status: z.enum(["active", "inactive", "faulty"]).optional(),
});

export const listTimeDevicesSchema = paginationSchema.extend({
  status: z.enum(["active", "inactive", "faulty"]).optional(),
  type: z.enum(["biometric", "rfid", "mobile", "other"]).optional(),
});

export const createSyncLogSchema = z.object({
  deviceId: z.number().int().positive(),
  status: z.enum(["success", "failed", "partial"]),
  recordsCount: z.number().int().min(0).default(0),
  error: z.string().optional(),
});

export const listSyncLogsSchema = paginationSchema.extend({
  deviceId: z.number().int().positive().optional(),
  status: z.enum(["success", "failed", "partial"]).optional(),
});

export const createDeviceMappingSchema = z.object({
  deviceId: z.number().int().positive(),
  userId: z.string().min(1),
  biometricId: z.string().optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
});

export const listDeviceMappingsSchema = paginationSchema.extend({
  deviceId: z.number().int().positive().optional(),
  userId: z.string().optional(),
});

// ─── Pack 2: Payroll Compliance ───────────────────────────────────────────────

export const createVarianceApprovalSchema = z.object({
  payrollPeriodKey: z.string().min(1),
  variancePct: z.number(),
  thresholdPct: z.number(),
});

export const resolveVarianceSchema = z.object({
  action: z.enum(["approved", "rejected"]),
  note: z.string().optional(),
});

export const listVarianceApprovalsSchema = paginationSchema.extend({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  payrollPeriodKey: z.string().optional(),
});

export const createArrearsSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().min(1).max(500),
  amountCents: z.number().int(),
  sourcePeriod: z.string().min(1),
  targetPeriod: z.string().min(1),
});

export const listArrearsSchema = paginationSchema.extend({
  userId: z.string().optional(),
  status: z.enum(["pending", "applied"]).optional(),
});

export const createComplianceTaskSchema = z.object({
  countryCode: z.string().length(2),
  name: z.string().min(1).max(300),
  dueDate: z.string(),
  notes: z.string().optional(),
});

export const updateComplianceTaskSchema = createComplianceTaskSchema.partial().extend({
  status: z.enum(["pending", "completed", "overdue"]).optional(),
});

export const listComplianceTasksSchema = paginationSchema.extend({
  countryCode: z.string().optional(),
  status: z.enum(["pending", "completed", "overdue"]).optional(),
});

// ─── Pack 3: Compensation Planning ───────────────────────────────────────────

export const createCompCycleSchema = z.object({
  name: z.string().min(1).max(200),
  fiscalYear: z.number().int().min(2000).max(2100),
  budgetPoolCents: z.number().int().min(0),
  meritMatrix: z.record(z.string(), z.number()).optional(),
});

export const updateCompCycleSchema = createCompCycleSchema.partial().extend({
  status: z.enum(["draft", "active", "calibrating", "approved", "closed"]).optional(),
});

export const listCompCyclesSchema = paginationSchema.extend({
  status: z.enum(["draft", "active", "calibrating", "approved", "closed"]).optional(),
  fiscalYear: z.coerce.number().int().optional(),
});

export const createRecommendationSchema = z.object({
  cycleId: z.number().int().positive(),
  userId: z.string().min(1),
  currentSalaryCents: z.number().int().min(0),
  recommendedIncreaseCents: z.number().int().min(0),
  recommendedPct: z.number().min(0).max(100),
  rating: z.string().optional(),
  managerNote: z.string().optional(),
});

export const updateRecommendationSchema = z.object({
  recommendedIncreaseCents: z.number().int().min(0).optional(),
  recommendedPct: z.number().min(0).max(100).optional(),
  rating: z.string().optional(),
  managerNote: z.string().optional(),
});

export const calibrateRecommendationSchema = z.object({
  hrCalibratedCents: z.number().int().min(0),
});

export const listRecommendationsSchema = paginationSchema.extend({
  cycleId: z.number().int().positive().optional(),
  userId: z.string().optional(),
  status: z.enum(["draft", "submitted", "calibrated", "approved"]).optional(),
});

export const approveRecommendationSchema = z.object({
  employmentId: z.number().int().positive(),
  effectiveFrom: z.string(),
});

export const createBudgetPoolSchema = z.object({
  cycleId: z.number().int().positive(),
  departmentId: z.number().int().positive().optional(),
  allocatedCents: z.number().int().min(0),
});

// ─── Pack 4: Equity ───────────────────────────────────────────────────────────

export const createEquityGrantSchema = z.object({
  userId: z.string().min(1),
  grantType: z.enum(["ISO", "NSO", "RSU", "other"]),
  units: z.number().int().positive(),
  strikePriceCents: z.number().int().min(0).optional(),
  grantDate: z.string(),
  cliffMonths: z.number().int().min(0),
  vestingMonths: z.number().int().positive(),
  documentUrl: z.string().url().optional(),
  notes: z.string().optional(),
});

export const updateEquityGrantSchema = z.object({
  status: z.enum(["active", "exercised", "cancelled", "expired"]).optional(),
  documentUrl: z.string().url().optional(),
  notes: z.string().optional(),
  boardApprovedAt: z.string().optional(),
});

export const listEquityGrantsSchema = paginationSchema.extend({
  userId: z.string().optional(),
  status: z.enum(["active", "exercised", "cancelled", "expired"]).optional(),
  grantType: z.enum(["ISO", "NSO", "RSU", "other"]).optional(),
});

export const createExerciseSchema = z.object({
  grantId: z.number().int().positive(),
  exerciseDate: z.string(),
  units: z.number().int().positive(),
  amountCents: z.number().int().min(0),
  notes: z.string().optional(),
});

export const exitTreatmentQuerySchema = z.object({
  exitDate: z.string(),
});

export type CreateTimeDeviceInput = z.infer<typeof createTimeDeviceSchema>;
export type UpdateTimeDeviceInput = z.infer<typeof updateTimeDeviceSchema>;
export type ListTimeDevicesInput = z.infer<typeof listTimeDevicesSchema>;
export type CreateSyncLogInput = z.infer<typeof createSyncLogSchema>;
export type ListSyncLogsInput = z.infer<typeof listSyncLogsSchema>;
export type CreateDeviceMappingInput = z.infer<typeof createDeviceMappingSchema>;
export type ListDeviceMappingsInput = z.infer<typeof listDeviceMappingsSchema>;
export type CreateVarianceApprovalInput = z.infer<typeof createVarianceApprovalSchema>;
export type ResolveVarianceInput = z.infer<typeof resolveVarianceSchema>;
export type ListVarianceApprovalsInput = z.infer<typeof listVarianceApprovalsSchema>;
export type CreateArrearsInput = z.infer<typeof createArrearsSchema>;
export type ListArrearsInput = z.infer<typeof listArrearsSchema>;
export type CreateComplianceTaskInput = z.infer<typeof createComplianceTaskSchema>;
export type UpdateComplianceTaskInput = z.infer<typeof updateComplianceTaskSchema>;
export type ListComplianceTasksInput = z.infer<typeof listComplianceTasksSchema>;
export type CreateCompCycleInput = z.infer<typeof createCompCycleSchema>;
export type UpdateCompCycleInput = z.infer<typeof updateCompCycleSchema>;
export type ListCompCyclesInput = z.infer<typeof listCompCyclesSchema>;
export type CreateRecommendationInput = z.infer<typeof createRecommendationSchema>;
export type UpdateRecommendationInput = z.infer<typeof updateRecommendationSchema>;
export type CalibrateRecommendationInput = z.infer<typeof calibrateRecommendationSchema>;
export type ListRecommendationsInput = z.infer<typeof listRecommendationsSchema>;
export type ApproveRecommendationInput = z.infer<typeof approveRecommendationSchema>;
export type CreateBudgetPoolInput = z.infer<typeof createBudgetPoolSchema>;
export type CreateEquityGrantInput = z.infer<typeof createEquityGrantSchema>;
export type UpdateEquityGrantInput = z.infer<typeof updateEquityGrantSchema>;
export type ListEquityGrantsInput = z.infer<typeof listEquityGrantsSchema>;
export type CreateExerciseInput = z.infer<typeof createExerciseSchema>;
export type ExitTreatmentQuery = z.infer<typeof exitTreatmentQuerySchema>;
