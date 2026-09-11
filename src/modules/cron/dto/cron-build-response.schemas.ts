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

/**
 * The six CRM sweeps below all come back as `{ success, message, ...result }`,
 * where `result` is the tally the service returns. Each keeps `organizations`
 * (tenants that finished) and `failed` (tenants that rolled back) apart from the
 * work counts, because a sweep whose every tenant failed and one that had nothing
 * to do both report zero work otherwise.
 */
export const crmLifecycleTriggersSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    considered: z.number().int().nonnegative(),
    opened: z.number().int().nonnegative(),
    reoffered: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
  }),
]);

export const crmSilenceSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    considered: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
  }),
]);

/**
 * The nurture sweep is the one place `failed` carries two meanings, so the
 * service keeps them under two names: `failed` counts a due step whose compose
 * threw, `organizationsFailed` counts a tenant whose whole pass rolled back.
 */
export const crmNurtureStepsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    considered: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    exited: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
]);

export const crmReportSchedulesResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
  }),
]);

/** `refused` is a tenant told no, not an error; `failed` is the error count. */
export const crmDealForecastResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    trained: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    scored: z.number().int().nonnegative(),
  }),
]);

export const crmFieldRepairsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    repaired: z.number().int().nonnegative(),
    leftForAPerson: z.number().int().nonnegative(),
  }),
]);
