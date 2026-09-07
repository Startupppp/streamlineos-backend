import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const wfhRequestRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  date: z.string(),
  reason: z.string().nullable(),
  status: z.string(),
  approverId: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  userMembershipId: z.number().int().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const wfhPendingItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  date: z.string(),
  reason: z.string().nullable(),
  status: z.string(),
  approverId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  user: z.object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  }),
});

export const shiftTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  type: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  breakMinutes: z.number().int(),
  isNightShift: z.boolean(),
  gracePeriodMinutes: z.number().int(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const shiftAssignmentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  shiftId: z.number().int(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
});

export const shiftSwapRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  requesterId: z.string(),
  requesterMembershipId: z.number().int().nullable(),
  targetUserId: z.string(),
  targetMembershipId: z.number().int().nullable(),
  requestDate: z.string(),
  targetDate: z.string(),
  reason: z.string().nullable(),
  status: z.string(),
  approverId: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const rosterRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  weekStart: z.string(),
  weekEnd: z.string(),
  status: z.string(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const rosterEntryRowSchema = z.object({
  id: z.number().int(),
  rosterId: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  shiftId: z.number().int().nullable(),
  date: z.string(),
  isDayOff: z.boolean().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
});

export const overtimeRequestRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  date: z.string(),
  hours: z.string(),
  reason: z.string().nullable(),
  status: z.string(),
  approverId: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  convertToCompOff: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const compOffBalanceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  earnedDays: z.string(),
  usedDays: z.string(),
  expiryDate: z.string().nullable(),
  updatedAt: wireDate(),
});

export const overtimeListResponseSchema = z.object({
  items: z.array(overtimeRequestRowSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const timesheetRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  ticketId: z.number().int().nullable(),
  date: z.string(),
  hours: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  workLink: z.string().nullable(),
  status: z.string(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  isBillable: z.boolean(),
  payrollStatus: z.string(),
  payrollExportId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  timesheetPeriodId: z.number().int().nullable(),
  timerSessionId: z.number().int().nullable(),
  billingType: z.string(),
  billRate: z.string().nullable(),
  costRate: z.string().nullable(),
  currency: z.string().nullable(),
  rateSource: z.string().nullable(),
  invoicingStatus: z.string(),
  submittedAt: nullableWireDate(),
  lockedAt: nullableWireDate(),
  lockedByMembershipId: z.number().int().nullable(),
  voidedAt: nullableWireDate(),
  voidReason: z.string().nullable(),
  source: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});
