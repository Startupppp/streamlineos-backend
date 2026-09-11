import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

export const trialExpirySweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    expired: z.number().int().nonnegative(),
    reminded: z.number().int().nonnegative(),
  }),
]);

export const monthlyPlanGrantsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    granted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
]);

export const aiReservationsSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    released: z.number().int().nonnegative(),
  }),
]);

export const autoTopUpFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    topped: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
]);

export const providerWebhookRedriveResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    attempted: z.number().int().nonnegative(),
    recovered: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
]);

export const aiJobsFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    claimed: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
]);
