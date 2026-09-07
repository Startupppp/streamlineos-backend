import { z } from "zod";
import { nullableWireDate } from "../../../common/openapi/wire-types";

export const inboundIngressAcceptResponseSchema = z.union([
  z.object({
    status: z.literal("accepted"),
    inboundEventId: z.string(),
    workflowRunId: z.string().nullable(),
  }),
  z.object({
    status: z.literal("duplicate"),
    inboundEventId: z.string(),
  }),
]);

const crmMailboxRowSchema = z.object({
  crmMailboxSyncId: z.string(),
  connectionId: z.number().int().positive(),
  mailboxAddress: z.string(),
  provider: z.string(),
  enabled: z.boolean(),
  syncedThrough: nullableWireDate(),
  lastRunAt: nullableWireDate(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
});

export const crmMailboxListResponseSchema = z.array(crmMailboxRowSchema);

export const crmMailboxEnableResponseSchema = z.object({
  crmMailboxSyncId: z.string().nullable(),
  enabled: z.literal(true),
});

export const crmMailboxDisableResponseSchema = z.object({ enabled: z.literal(false) });

export const crmMailboxSyncResponseSchema = z.union([
  z.object({ swept: z.literal(false), reason: z.string() }),
  z.object({
    swept: z.literal(true),
    delivered: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unjudged: z.number().int().nonnegative(),
    read: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);

export const crmMailboxSweepAllResponseSchema = z.object({
  mailboxes: z.number().int().nonnegative(),
  swept: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
});
