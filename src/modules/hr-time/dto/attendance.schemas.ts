import { z } from "zod";

export const checkInSchema = z.object({
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      address: z.string().max(500).optional(),
    })
    .nullish(),
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const checkOutSchema = z.object({
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const monthlyQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number(),
  month: z.coerce.number(),
});

export const heatmapQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number().int().optional(),
});

export const attendanceLogsQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().optional(),
});

export type CheckInInput = z.infer<typeof checkInSchema>;
export type CheckOutInput = z.infer<typeof checkOutSchema>;
export type MonthlyQuery = z.infer<typeof monthlyQuerySchema>;
export type HeatmapQuery = z.infer<typeof heatmapQuerySchema>;
export type AttendanceLogsQuery = z.infer<typeof attendanceLogsQuerySchema>;
