import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";
import { nullableWireDate } from "../../../common/openapi/wire-types";

export const outboxEventsWorkerResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    claimed: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    suppressed: z.number().int().nonnegative(),
    retried: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
    fenced: z.number().int().nonnegative(),
  }),
]);

const outboxOrgReportSchema = z.object({
  organizationId: z.string(),
  totalRows: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
  oldestPendingAt: nullableWireDate(),
  oldestEventAt: nullableWireDate(),
  oldestEventAgeSeconds: z.number().nullable(),
  distinctEventTypes: z.number().int().nonnegative(),
});

export const outboxMetricsResponseSchema = z.object({
  pending: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
  oldestPendingAt: nullableWireDate(),
});

export const outboxReportResponseSchema = z.object({
  generatedAt: z.string(),
  organizations: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reports: z.array(outboxOrgReportSchema),
});

export const outboxEventsReplayDeadQuerySchema = z
  .object({
    eventType: z.string().min(1).max(200).optional(),
    organizationId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const outboxEventsReplayDeadResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizationsProcessed: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    replayed: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);

export const outboxEventsRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    outboxEventsDeleted: z.number().int().nonnegative(),
    inboxRecordsDeleted: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);
