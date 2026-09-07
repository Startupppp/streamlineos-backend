import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { hrEquityGrantTypeEnum, hrEquityGrantStatusEnum } from "../../../../db/schema/hr/enterprise-comp";

const compCycleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  fiscalYear: z.number().int(),
  status: z.enum(["draft", "active", "calibrating", "approved", "closed"]),
  budgetPoolCents: z.number(),
  meritMatrix: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createCompCycleResponseSchema = compCycleSchema;
export const listCompCyclesResponseSchema = cursorPageSchema(compCycleSchema);
export const getCompCycleResponseSchema = compCycleSchema;
export const updateCompCycleResponseSchema = compCycleSchema;

const recommendationProjectionSchema = z.object({
  id: z.number().int(),
  cycleId: z.number().int(),
  userId: z.string(),
  currentSalaryCents: z.number(),
  recommendedIncreaseCents: z.number(),
  recommendedPct: z.string(),
  rating: z.string().nullable(),
  managerNote: z.string().nullable(),
  hrCalibratedCents: z.number().nullable(),
  status: z.enum(["draft", "submitted", "calibrated", "approved"]),
  createdAt: wireDate(),
});

const fullRecommendationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  cycleId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  currentSalaryCents: z.number(),
  recommendedIncreaseCents: z.number(),
  recommendedPct: z.string(),
  rating: z.string().nullable(),
  managerNote: z.string().nullable(),
  hrCalibratedCents: z.number().nullable(),
  status: z.enum(["draft", "submitted", "calibrated", "approved"]),
  submittedBy: z.string().nullable(),
  calibratedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createRecommendationResponseSchema = fullRecommendationSchema;
export const listRecommendationsResponseSchema = cursorPageSchema(recommendationProjectionSchema);
export const updateRecommendationResponseSchema = fullRecommendationSchema;
export const calibrateRecommendationResponseSchema = fullRecommendationSchema;
export const approveRecommendationResponseSchema = z.object({ approved: z.literal(true), finalCents: z.number().int() });

const budgetPoolSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  cycleId: z.number().int(),
  departmentId: z.string().nullable(),
  allocatedCents: z.number(),
  usedCents: z.number(),
  createdAt: wireDate(),
});

export const listBudgetPoolsResponseSchema = z.array(budgetPoolSchema);
export const createBudgetPoolResponseSchema = budgetPoolSchema;

const timeDeviceSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  serialNumber: z.string(),
  type: z.enum(["biometric", "rfid", "mobile", "other"]),
  locationId: z.string().nullable(),
  status: z.enum(["active", "inactive", "faulty"]),
  lastSyncAt: nullableWireDate(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const syncLogSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  deviceId: z.number().int(),
  status: z.enum(["success", "failed", "partial"]),
  recordsCount: z.number().int(),
  error: z.string().nullable(),
  syncedAt: wireDate(),
});

const deviceMappingSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  deviceId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  biometricId: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  createdAt: wireDate(),
});

export const listDevicesResponseSchema = cursorPageSchema(timeDeviceSchema);
export const createDeviceResponseSchema = timeDeviceSchema;
export const updateDeviceResponseSchema = timeDeviceSchema;

export const listSyncLogsResponseSchema = cursorPageSchema(syncLogSchema);
export const ingestSyncLogResponseSchema = z.object({ inserted: z.number().int() });

export const listDeviceMappingsResponseSchema = cursorPageSchema(deviceMappingSchema);
export const createDeviceMappingResponseSchema = deviceMappingSchema;

const varianceApprovalSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  payrollPeriodKey: z.string(),
  variancePct: z.string(),
  thresholdPct: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  approverId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: wireDate(),
  resolvedAt: nullableWireDate(),
});

const arrearsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  reason: z.string(),
  amountCents: z.number(),
  sourcePeriod: z.string(),
  targetPeriod: z.string(),
  status: z.enum(["pending", "applied"]),
  createdBy: z.string().nullable(),
  appliedAt: nullableWireDate(),
  createdAt: wireDate(),
});

const complianceTaskSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  countryCode: z.string(),
  name: z.string(),
  dueDate: z.string(),
  status: z.enum(["pending", "completed", "overdue"]),
  notes: z.string().nullable(),
  completedBy: z.string().nullable(),
  completedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const listVarianceApprovalsResponseSchema = cursorPageSchema(varianceApprovalSchema);
export const createVarianceApprovalResponseSchema = varianceApprovalSchema;
export const resolveVarianceApprovalResponseSchema = varianceApprovalSchema;

export const listArrearsResponseSchema = cursorPageSchema(arrearsSchema);
export const createArrearResponseSchema = arrearsSchema;
export const applyArrearResponseSchema = arrearsSchema;

export const listComplianceTasksResponseSchema = cursorPageSchema(complianceTaskSchema);
export const createComplianceTaskResponseSchema = complianceTaskSchema;
export const completeComplianceTaskResponseSchema = complianceTaskSchema;

const equityGrantTypeSchema = z.enum(hrEquityGrantTypeEnum.enumValues);
const equityGrantStatusSchema = z.enum(hrEquityGrantStatusEnum.enumValues);

const equityGrantSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  grantType: equityGrantTypeSchema,
  units: z.number().int(),
  strikePriceCents: z.number().int().nullable(),
  grantDate: z.string(),
  cliffMonths: z.number().int(),
  vestingMonths: z.number().int(),
  documentUrl: z.string().nullable(),
  notes: z.string().nullable(),
  status: equityGrantStatusSchema,
  createdBy: z.string().nullable(),
  boardApprovedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const vestingEventSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  grantId: z.number().int(),
  vestDate: z.string(),
  unitsVested: z.number().int(),
  cumulativeVested: z.number().int(),
});

const scheduleItem = z.object({ vestDate: z.string(), unitsVested: z.number().int(), cumulativeVested: z.number().int() });

export const createGrantResponseSchema = equityGrantSchema.extend({ vestingSchedule: z.array(scheduleItem) });
export const listGrantsResponseSchema = cursorPageSchema(equityGrantSchema);
export const getGrantResponseSchema = equityGrantSchema.extend({ vestingEvents: z.array(vestingEventSchema), exercises: z.array(z.object({ id: z.number().int(), orgId: z.string(), grantId: z.number().int(), units: z.number().int(), exerciseDate: z.string(), createdBy: z.string().nullable(), createdAt: wireDate() })) });
export const updateGrantResponseSchema = equityGrantSchema;
export const getVestingScheduleResponseSchema = z.array(vestingEventSchema);
export const recordExerciseResponseSchema = z.object({ id: z.number().int(), orgId: z.string(), grantId: z.number().int(), units: z.number().int(), exerciseDate: z.string(), createdBy: z.string().nullable(), createdAt: wireDate() });
export const getExitTreatmentResponseSchema = z.object({
  vestedUnits: z.number().int(),
  exercisedUnits: z.number().int(),
  unvestedUnits: z.number().int(),
  exercisableUnits: z.number().int(),
  grantType: equityGrantTypeSchema,
  notes: z.string().nullable(),
  exitDate: z.string(),
});

export const getWorkforceCostResponseSchema = z.object({
  departmentBreakdown: z.array(z.object({ departmentId: z.string().nullable(), departmentName: z.string().nullable(), headcount: z.number().int(), totalCostCents: z.number() })),
  total: z.object({ headcount: z.number().int(), totalCostCents: z.number() }),
});

export const submitRecommendationResponseSchema = fullRecommendationSchema;
export const listFailedSyncsResponseSchema = z.array(syncLogSchema);
export const detectDuplicatePunchesResponseSchema = z.array(z.object({
  biometricUserId: z.string().nullable(),
  userId: z.string().nullable(),
  punchWindow: z.string(),
  count: z.number().int(),
}));
export const seedCountryPresetsResponseSchema = z.object({ seeded: z.number().int(), message: z.string().optional() });
export const forecastedCostResponseSchema = z.object({
  cycleId: z.number().int(),
  fiscalYear: z.number().int().optional(),
  budgetPoolCents: z.number(),
  headcount: z.number().int(),
  totalCurrentAnnualCents: z.number(),
  totalForecastedAnnualCents: z.number(),
  totalIncreaseCents: z.number(),
});

export const costSummaryResponseSchema = z.object({
  totalHeadcount: z.number().int(),
  totalAnnualCtcCents: z.number(),
  totalMonthlyCostCents: z.number(),
});

export const costByDepartmentResponseSchema = z.array(z.object({
  departmentId: z.string().nullable(),
  departmentName: z.string().nullable(),
  headcount: z.number().int(),
  monthlyCostCents: z.number(),
}));

export const costByLocationResponseSchema = z.array(z.object({
  locationId: z.string(),
  headcount: z.number().int(),
  monthlyCostCents: z.number(),
}));
