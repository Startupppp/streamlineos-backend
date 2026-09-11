import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

export const dailyNotificationsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    birthdayCount: z.number().int().nonnegative(),
    leaveCount: z.number().int().nonnegative(),
    anniversaryCount: z.number().int().nonnegative(),
  }),
]);

export const holidayNotificationsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    count: z.number().int().nonnegative(),
  }),
]);

export const offerDeadlineRemindersResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    remindedCount: z.number().int().nonnegative(),
  }),
]);

export const certificationExpiryResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    fired: z.number().int().nonnegative(),
  }),
]);

export const weeklyExecRecapResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    results: z.array(
      z.object({
        orgId: z.string(),
        sent: z.boolean(),
        error: z.string().optional(),
      }),
    ),
    generatedAt: z.string(),
  }),
]);

export const documentExpiryResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    fired: z.number().int().nonnegative(),
  }),
]);
