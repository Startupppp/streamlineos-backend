import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

export const projectsRecurringFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    spawned: z.number().int().nonnegative(),
    advanced: z.number().int().nonnegative(),
  }),
]);

export const crmSequencesFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    processed: z.number().int().nonnegative(),
    advanced: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
  }),
]);

const financeRunResultSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  ran: z.array(z.string()),
  errors: z.array(z.object({ task: z.string(), error: z.string() })),
});

export const financeRecurringFlushResponseSchema = z.union([cronSkippedSchema, financeRunResultSchema]);
export const financeDueChecksResponseSchema = z.union([cronSkippedSchema, financeRunResultSchema]);
export const financeDepreciationResponseSchema = z.union([cronSkippedSchema, financeRunResultSchema]);

export const crmTasksOverdueFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    emitted: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);

export const buildRetentionPruneResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    webhookDeliveriesPruned: z.number().int().nonnegative(),
  }),
]);

export const buildDailySnapshotsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsVisited: z.number().int().nonnegative(),
    orgsFailed: z.number().int().nonnegative(),
    projectsProcessed: z.number().int().nonnegative(),
    projectsSkipped: z.number().int().nonnegative(),
    projectsFailed: z.number().int().nonnegative(),
  }),
]);
