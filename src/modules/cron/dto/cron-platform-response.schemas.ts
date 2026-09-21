import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

const workflowSkippedSchema = z.object({
  ok: z.literal(true),
  skipped: z.literal(true),
  message: z.string(),
});

export const workflowTickResponseSchema = z.union([
  workflowSkippedSchema,
  z.object({
    ok: z.literal(true),
    relayed: z.number().int().nonnegative(),
    scanned: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    outcomes: z.record(
      z.enum(["completed", "suspended", "retry", "dead-lettered"]),
      z.number().int().nonnegative(),
    ),
  }),
]);

export const buildDueSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    dueSoon: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    sprintsEnding: z.number().int().nonnegative(),
  }),
]);

export const emailOutboxFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    processed: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
  }),
]);

export const invitationExpiryResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    expired: z.number().int().nonnegative(),
  }),
]);

export const ownershipTransferExpiryResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    expired: z.number().int().nonnegative(),
  }),
]);

export const accountOrgIndexRebuildResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
]);

export const orgPurgeWorkerResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    processed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    moreRemaining: z.boolean(),
  }),
]);

export const idempotencyFenceSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    commandFencesPruned: z.number().int().nonnegative(),
    invKeysPruned: z.number().int().nonnegative(),
    payrollReceiptsPruned: z.number().int().nonnegative(),
  }),
]);

export const timesheetsExceptionDetectionResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsScanned: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
  }),
]);

export const operatorGrantExpiryResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    expired: z.number().int().nonnegative(),
  }),
]);

export const aiUsageRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    dryRun: z.boolean(),
    organizationsScanned: z.number().int().nonnegative(),
    rowsDeleted: z.number().int().nonnegative(),
    rowsWouldDelete: z.number().int().nonnegative(),
  }),
]);

export const mailMetadataRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    organizations: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    rowsDeleted: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);

export const announcementsRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    organizations: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    expiredDeleted: z.number().int().nonnegative(),
    agedDeleted: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);

/**
 * `orgsTruncated` is the number that says the sweep stopped early rather than
 * finished, and `orgsMalformed` the one that says a tenant's stored reminder
 * rules did not parse. Both are folded into the message only conditionally, so
 * they have to be on the contract or an operator cannot see them at all.
 */
export const timesheetsRemindersResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsScanned: z.number().int().nonnegative(),
    orgsMalformed: z.number().int().nonnegative(),
    periodsConsidered: z.number().int().nonnegative(),
    remindersSent: z.number().int().nonnegative(),
    orgsTruncated: z.number().int().nonnegative(),
  }),
]);

export const timesheetsApprovalEscalationResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsScanned: z.number().int().nonnegative(),
    periodsOverdue: z.number().int().nonnegative(),
    periodsEscalated: z.number().int().nonnegative(),
    periodsUnowned: z.number().int().nonnegative(),
  }),
]);
