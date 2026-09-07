import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

export const notificationTimeSweepsResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    due: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    slaBreached: z.number().int().nonnegative(),
    invoicesDueSoon: z.number().int().nonnegative(),
    envelopesExpiring: z.number().int().nonnegative(),
    eventsStartingSoon: z.number().int().nonnegative(),
  }),
]);

export const notificationDigestFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    windows: z.number().int().nonnegative(),
    itemsFlushed: z.number().int().nonnegative(),
    notificationsCreated: z.number().int().nonnegative(),
  }),
]);

export const notificationOutboxFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    claimed: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    retried: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
  }),
]);

export const notificationsRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    emailBodiesPurged: z.number().int().nonnegative(),
    emailRecordsDeleted: z.number().int().nonnegative(),
    deliveryBodiesPurged: z.number().int().nonnegative(),
    deliveryRecordsDeleted: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);

export const notificationsRetentionDetachResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    partitionsDetached: z.number().int().nonnegative(),
    partitionsDropped: z.number().int().nonnegative(),
    tables: z.record(z.string(), z.object({ detached: z.number().int(), dropped: z.number().int() })),
  }),
]);

export const chatReplyRemindersResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    sent: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
]);

export const notificationDeliveryFlushResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    processed: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
  }),
]);

export const notificationOutboxRetentionSweepResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizationsScanned: z.number().int().nonnegative(),
    rowsDeleted: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);
