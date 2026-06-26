import { z } from "zod";

export const attendanceReportSchema = z.object({
  userId: z.string().optional(),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

export const payrollReportSchema = z.object({
  userId: z.string().optional(),
  startMonth: z.string().min(1),
  endMonth: z.string().min(1),
});

export const projectReportSchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const teamPerformanceReportSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

export type AttendanceReportInput = z.infer<typeof attendanceReportSchema>;
export type PayrollReportInput = z.infer<typeof payrollReportSchema>;
export type ProjectReportInput = z.infer<typeof projectReportSchema>;
export type TeamPerformanceReportInput = z.infer<typeof teamPerformanceReportSchema>;
