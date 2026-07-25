import { z } from "zod";

export const leaveAnalyticsQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
});

export const leaveCalendarQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{1,2}$/)
    .transform(Number)
    .optional(),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number)
    .optional(),
});

export const updateLeaveSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "PENDING"]),
  rejectionReason: z.string().optional(),
});

export const approveLeaveSchema = z.object({
  comment: z.string().optional(),
  forceApprove: z.boolean().optional(),
  justification: z.string().optional(),
});

export const rejectLeaveSchema = z.object({
  reason: z.string().min(1, "Rejection reason is required."),
  comment: z.string().optional(),
});

export const createLeaveSchema = z
  .object({
    leaveTypeId: z.number(),
    startDate: z.string(),
    endDate: z.string(),
    reason: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .string()
        .trim()
        .min(10, "Reason must be at least 10 characters")
        .max(500, "Reason must be at most 500 characters")
        .optional(),
    ),
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().default("MEDIUM"),
    approverId: z.string().optional(),
    attachmentUrl: z.string().optional(),
    isHalfDay: z.boolean().optional().default(false),
    halfDayPeriod: z.enum(["AM", "PM"]).optional(),
  })
  .refine((d) => d.endDate >= d.startDate, {
    message: "End date must be on or after start date",
    path: ["endDate"],
  })
  .refine((d) => !d.isHalfDay || d.startDate === d.endDate, {
    message: "Half-day leave cannot span multiple dates",
    path: ["endDate"],
  });

export const compOffSchema = z.object({
  userId: z.string().min(1),
  days: z.number().positive().max(30),
  reason: z.string().optional(),
});

export type LeaveAnalyticsQuery = z.infer<typeof leaveAnalyticsQuerySchema>;
export type LeaveCalendarQuery = z.infer<typeof leaveCalendarQuerySchema>;
export type UpdateLeaveInput = z.infer<typeof updateLeaveSchema>;
export type ApproveLeaveInput = z.infer<typeof approveLeaveSchema>;
export type RejectLeaveInput = z.infer<typeof rejectLeaveSchema>;
export type CreateLeaveInput = z.infer<typeof createLeaveSchema>;
export type CompOffInput = z.infer<typeof compOffSchema>;

export const createLeaveTypeSchema = z.object({
  name: z.string().min(1).max(100),
  daysPerYear: z.number().int().min(0).max(365),
  carryForward: z.boolean().optional(),
});
export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;

export const updateLeaveTypeSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    daysPerYear: z.number().int().min(0).max(365).optional(),
    carryForward: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;
