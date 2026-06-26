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

export const compOffSchema = z.object({
  userId: z.string().min(1),
  days: z.number().positive().max(30),
  reason: z.string().optional(),
});

export type LeaveAnalyticsQuery = z.infer<typeof leaveAnalyticsQuerySchema>;
export type LeaveCalendarQuery = z.infer<typeof leaveCalendarQuerySchema>;
export type UpdateLeaveInput = z.infer<typeof updateLeaveSchema>;
export type CompOffInput = z.infer<typeof compOffSchema>;
