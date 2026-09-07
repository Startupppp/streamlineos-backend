import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const leaveTypeRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  daysPerYear: z.number().int(),
  carryForward: z.boolean(),
});

export const leaveBalanceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  leaveTypeId: z.number().int(),
  balance: z.string(),
  year: z.number().int(),
});

export const leaveRequestRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  workerId: z.string().nullable(),
  workerEngagementId: z.string().nullable(),
  leaveTypeId: z.number().int(),
  startDate: z.string(),
  endDate: z.string(),
  reason: z.string().nullable(),
  priority: z.string(),
  status: z.string(),
  approverId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  managerComment: z.string().nullable(),
  attachmentUrl: z.string().nullable(),
  isHalfDay: z.boolean(),
  halfDayPeriod: z.string().nullable(),
  coveringEmployeeId: z.string().nullable(),
  lopDays: z.string(),
  approverMembershipId: z.number().int().nullable(),
  userMembershipId: z.number().int().nullable(),
  coveringEmployeeMembershipId: z.number().int().nullable(),
  rowVersion: z.number().int(),
  createdByMembershipId: z.number().int().nullable(),
  updatedByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const leaveRequestWithRelationsSchema = leaveRequestRowSchema.extend({
  leaveType: z.object({ id: z.number().int(), name: z.string(), daysPerYear: z.number().int() }).nullable(),
  approver: z.object({ id: z.string(), name: z.string().nullable(), firstName: z.string().nullable(), lastName: z.string().nullable() }).nullable(),
});

export const leavePolicyRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  leaveTypeId: z.number().int(),
  name: z.string(),
  accrualType: z.string(),
  accrualRate: z.string(),
  maxBalance: z.string().nullable(),
  carryForwardDays: z.string(),
  carryForwardExpiryMonths: z.number().int().nullable(),
  encashable: z.boolean(),
  probationRestricted: z.boolean(),
  genderRestriction: z.string().nullable(),
  appliesTo: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
});

export const leavePolicySummaryPageDataSchema = z.object({
  wfhMonthlyQuota: z.number().nullable(),
  leaveTypes: z.array(z.object({
    name: z.string(),
    daysPerYear: z.number().int(),
    carryForward: z.boolean(),
    expiresMonthly: z.boolean(),
  })),
});

export const leavesMyResponseSchema = z.object({
  data: z.array(leaveRequestWithRelationsSchema),
  pageInfo: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.number().int().nullable(),
  }),
});

export const leavesTeamItemSchema = leaveRequestRowSchema.extend({
  leaveType: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  approver: z.object({ id: z.string(), name: z.string().nullable(), firstName: z.string().nullable(), lastName: z.string().nullable() }).nullable(),
  user: z.object({ id: z.string(), name: z.string().nullable(), firstName: z.string().nullable(), lastName: z.string().nullable(), image: z.string().nullable() }).nullable(),
});

export const leavesTeamResponseSchema = z.object({
  pending: z.array(leavesTeamItemSchema),
  all: z.array(leavesTeamItemSchema),
});

export const leavesThisWeekItemSchema = leaveRequestRowSchema.extend({
  leaveType: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    image: z.string().nullable(),
    designation: z.string().nullable(),
  }).nullable(),
});

export const leavesAnalyticsResponseSchema = z.object({
  year: z.number().int(),
  byDepartment: z.array(z.object({
    department: z.string(),
    total: z.number().int(),
    approved: z.number().int(),
    pending: z.number().int(),
    rejected: z.number().int(),
  })),
  monthlyTrend: z.array(z.object({ month: z.string(), count: z.number().int() })),
  byLeaveType: z.array(z.object({ typeName: z.string(), count: z.number().int() })),
  avgDaysByDepartment: z.array(z.object({ department: z.string(), avgDays: z.number() })),
});

export const leavesCreateResponseSchema = z.object({
  success: z.literal(true),
  conflictWarning: z.string().optional(),
});

export const leaveCalendarItemSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  userName: z.string(),
  userImage: z.string().nullable(),
  startDate: z.string(),
  endDate: z.string(),
  leaveType: z.string(),
  status: z.string(),
});

export const leaveSummaryRowSchema = z.object({
  userId: z.string(),
  paidLeaveDays: z.number(),
  unpaidLeaveDays: z.number(),
  halfDayCount: z.number(),
  hourlyLeaveHours: z.number(),
  compOffUsed: z.number(),
  encashmentDays: z.number(),
});

export const leavesPageDataSchema = z.object({
  balances: z.array(z.object({
    id: z.number().int(),
    leaveTypeId: z.number().int().nullable(),
    balance: z.string(),
    typeName: z.string().nullable(),
    daysPerYear: z.number().int().nullable(),
  })),
  types: z.array(leaveTypeRowSchema),
  joiningDate: z.string().nullable(),
  approvers: z.array(z.object({ id: z.string(), name: z.string().nullable(), email: z.string() })),
});

export const compOffGrantResponseSchema = z.object({
  success: z.literal(true),
  credited: z.number(),
  leaveTypeId: z.number().int().optional(),
});

export const seedLeaveTypesResponseSchema = z.object({
  seeded: z.number().int(),
  skipped: z.number().int(),
});

export const teamAvailabilityItemSchema = z.object({
  userId: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  leaveTypeId: z.number().int().nullable(),
  userName: z.string().nullable(),
  userImage: z.string().nullable(),
});

export { successSchema };
