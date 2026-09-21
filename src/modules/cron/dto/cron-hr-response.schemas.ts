import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

export const autoCheckoutResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    processed: z.number().int().nonnegative(),
    message: z.string(),
  }),
]);

export const monthlyLeaveResetResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    monthlyExpiry: z.object({ expiredCount: z.number().int().nonnegative() }),
    yearlyReset: z.object({ resetCount: z.number().int().nonnegative() }).nullable(),
  }),
]);

export const interviewNoShowsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    processedCount: z.number().int().nonnegative(),
  }),
]);

export const onboardingSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    fired: z.number().int().nonnegative(),
  }),
]);

const sweepItemSchema = z.object({
  orgId: z.string(),
  sweep: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const hrEnginesSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    results: z.array(sweepItemSchema),
    orgsProcessed: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
]);

export const hrEnginesSweepByNameResponseSchema = z.union([
  cronSkippedSchema,
  z.object({ success: z.literal(true), message: z.string(), swept: z.number().int().nonnegative() }),
  z.object({ success: z.literal(false), message: z.string() }),
]);

export const retentionDeleteSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    processed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
]);

export const hrPolicyRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    truncated: z.boolean(),
    employeeSoftDeleted: z.number().int().nonnegative(),
    caseSoftDeleted: z.number().int().nonnegative(),
    attendanceDeleted: z.number().int().nonnegative(),
    documentsDeleted: z.number().int().nonnegative(),
    onboardingDocumentsRedacted: z.number().int().nonnegative(),
    storageObjectsDeleted: z.number().int().nonnegative(),
    storageObjectsOrphaned: z.number().int().nonnegative(),
    protectedDocumentRecords: z.number().int().nonnegative(),
    protectedPayrollPolicies: z.number().int().nonnegative(),
    skippedDocumentPolicies: z.number().int().nonnegative(),
    skippedPayrollPolicies: z.number().int().nonnegative(),
  }),
]);

export const helpdeskRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    ticketsDeleted: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);

export const helpdeskEscalationSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
    unassignable: z.number().int().nonnegative(),
  }),
]);
