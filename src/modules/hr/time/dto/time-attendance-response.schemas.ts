import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const orgHolidayRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  date: z.string(),
  recurring: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const attendanceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  workerId: z.string().nullable(),
  workerEngagementId: z.string().nullable(),
  date: z.string(),
  checkIn: nullableWireDate(),
  checkOut: nullableWireDate(),
  status: z.string(),
  workHours: z.string().nullable(),
  breakHours: z.string(),
  breaks: z.array(z.object({ start: z.string(), end: z.string().optional() })),
  locationData: z.object({ lat: z.number().optional(), lng: z.number().optional(), address: z.string().optional() }).nullable(),
  isOvertime: z.boolean(),
  autoCheckedOut: z.boolean(),
  locationVerified: z.boolean(),
  createdAt: wireDate(),
});

export const attendanceStatusResponseSchema = z.object({
  status: z.string(),
  logs: z.array(attendanceRowSchema),
  todayLog: attendanceRowSchema.nullable(),
  dailyStats: z.object({
    workHours: z.string(),
    breakHours: z.string(),
    isOvertime: z.boolean(),
  }),
  cooldownRemaining: z.number(),
});

export const attendanceHeatmapResponseSchema = z.object({
  year: z.number().int(),
  userId: z.string(),
  heatmap: z.array(z.object({
    date: z.string(),
    hours: z.number(),
    sessions: z.number().int(),
    intensity: z.number().int(),
  })),
  summary: z.object({
    totalDays: z.number().int(),
    totalHours: z.string(),
    avgHoursPerDay: z.string(),
    longestStreak: z.number().int(),
  }),
});

export const attendanceHistoryResponseSchema = z.object({
  data: z.array(attendanceRowSchema),
  pagination: z.object({
    limit: z.number().int(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

export const teamStatusItemSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  department: z.string().nullable(),
  status: z.string(),
  checkIn: nullableWireDate(),
  checkOut: nullableWireDate(),
  workHours: z.string().nullable(),
});

export const teamStatusResponseSchema = z.object({
  data: z.array(teamStatusItemSchema),
  counts: z.object({
    PRESENT: z.number().int(),
    ON_BREAK: z.number().int(),
    CHECKED_OUT: z.number().int(),
    OFFLINE: z.number().int(),
  }),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    total: z.number().int(),
  }),
});

export const attendanceSummaryItemSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  payableDays: z.number(),
  presentDays: z.number().int(),
  absentDays: z.number().int(),
  lateCount: z.number().int(),
  latePenaltyDays: z.number(),
  earlyExitCount: z.number().int(),
  approvedRegularizations: z.number().int(),
  overtimeMinutes: z.number().int(),
  weekendWorkDays: z.number().int(),
  holidayWorkDays: z.number().int(),
});

export const attendanceSummaryResponseSchema = z.object({
  data: z.array(attendanceSummaryItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const geofenceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  lat: z.string(),
  lng: z.string(),
  radiusMeters: z.number().int(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const biometricDeviceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  ipAddress: z.string(),
  port: z.number().int(),
  vendor: z.string(),
  location: z.string().nullable(),
  isOnline: z.boolean(),
  lastSyncAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const biometricLogRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  deviceId: z.number().int(),
  userId: z.string().nullable(),
  userMembershipId: z.number().int().nullable(),
  biometricUserId: z.string().nullable(),
  punchTime: wireDate(),
  punchType: z.string(),
  rawData: z.record(z.string(), z.unknown()).nullable(),
  processed: z.boolean(),
  createdAt: wireDate(),
});

export const regularizationRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  attendanceDate: z.string(),
  requestedCheckIn: nullableWireDate(),
  requestedCheckOut: nullableWireDate(),
  reason: z.string(),
  status: z.string(),
  workflowInstanceId: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectedBy: z.string().nullable(),
  rejectedByMembershipId: z.number().int().nullable(),
  rejectedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  attendanceId: z.number().int().nullable(),
  userMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const regularizationApplyResponseSchema = z.object({
  success: z.literal(true),
  monthKey: z.string(),
  payrollInputRebuild: z.boolean(),
});

export const regularizationListResponseSchema = z.object({
  data: z.array(regularizationRowSchema),
  pagination: z.object({
    limit: z.number().int(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});
