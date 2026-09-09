import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

export const supportSlaEscalationsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsProcessed: z.number().int().nonnegative(),
    checked: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
  }),
]);

export const supportUnsnoozeResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    unsnoozed: z.number().int().nonnegative(),
  }),
]);

export const kbTrashPurgeResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsProcessed: z.number().int().nonnegative(),
    purgedCount: z.number().int().nonnegative(),
  }),
]);

export const kbChunkRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsProcessed: z.number().int().nonnegative(),
    articleChunksPruned: z.number().int().nonnegative(),
    pageChunksPruned: z.number().int().nonnegative(),
  }),
]);

export const supportKbGapDetectResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    processed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
]);

export const kbTelemetryRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsProcessed: z.number().int().nonnegative(),
    eventsDeleted: z.number().int().nonnegative(),
    checkpointsDeleted: z.number().int().nonnegative(),
  }),
]);

export const kbStuckSourceReapResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsProcessed: z.number().int().nonnegative(),
    orgsFailed: z.number().int().nonnegative(),
    sourcesFailed: z.number().int().nonnegative(),
    truncated: z.boolean(),
    leaseHealth: z.object({
      unavailableCount: z.number().int().nonnegative(),
      contendedCount: z.number().int().nonnegative(),
      lostCount: z.number().int().nonnegative(),
      lastUnavailableReason: z.string().nullable(),
    }),
  }),
]);

export const kbChatHistoryPurgeResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    orgsProcessed: z.number().int().nonnegative(),
    conversationsDeleted: z.number().int().nonnegative(),
  }),
]);

export const sessionRevocationPruneResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    removed: z.number().int().nonnegative(),
  }),
]);
