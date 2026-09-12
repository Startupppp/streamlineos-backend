import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../common/openapi/wire-types";

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

const whatsappChannelRowSchema = z.object({
  crmWhatsappChannelId: z.string(),
  businessPhoneNumberId: z.string(),
  businessNumber: z.string(),
  enabled: z.boolean(),
  /**
   * The honesty surface. A channel that verifies every delivery and files
   * nothing reads as a quiet week from anywhere else, so these three are on the
   * list rather than in a log.
   */
  lastDeliveryAt: nullableWireDate(),
  lastAcceptedAt: nullableWireDate(),
  lastNote: z.string().nullable(),
  createdAt: wireDate(),
});

export const whatsappChannelListResponseSchema = z.array(whatsappChannelRowSchema);

/**
 * `verifyToken` is shown exactly once — it is not stored in readable form and
 * rotation is how somebody who lost it carries on. `appSecretHint` is a mask of
 * what the caller just sent, never the secret.
 */
export const whatsappChannelCreateResponseSchema = z.object({
  crmWhatsappChannelId: z.string(),
  businessPhoneNumberId: z.string(),
  businessNumber: z.string(),
  enabled: z.boolean(),
  createdAt: wireDate(),
  verifyToken: z.string(),
  appSecretHint: z.string(),
  callbackPath: z.string(),
});

/**
 * The verify token is replaced every time; the app secret only when the caller
 * supplied a new one, so `appSecretHint` is absent rather than null on a
 * token-only rotation.
 */
export const whatsappChannelRotateResponseSchema = z.object({
  crmWhatsappChannelId: z.string(),
  verifyToken: z.string(),
  appSecretHint: z.string().optional(),
  callbackPath: z.string(),
});

export const whatsappChannelEnabledResponseSchema = z.object({
  crmWhatsappChannelId: z.string(),
  enabled: z.boolean(),
});

export const whatsappChannelRemovedResponseSchema = z.object({
  crmWhatsappChannelId: z.string(),
  removed: z.literal(true),
});

/**
 * What a settled delivery filed.
 *
 * Only the accepted shape is declared: a refusal leaves as a 401 and a partial
 * failure as a 503, so neither reaches this body. `skipped` is keyed by the
 * adapter's own reasons, and `note` carries its explanation of a delivery that
 * produced no activities — the field that keeps "verified and filed nothing"
 * from reading as silence.
 */
export const whatsappDeliveryResponseSchema = z.object({
  received: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
  foreign: z.number().int().nonnegative(),
  skipped: z.object({
    "no-identifier": z.number().int().nonnegative(),
    "no-sender": z.number().int().nonnegative(),
    "no-business-number": z.number().int().nonnegative(),
    "own-number-noise": z.number().int().nonnegative(),
    "unsupported-type": z.number().int().nonnegative(),
    empty: z.number().int().nonnegative(),
  }),
  note: z.string().nullable(),
});
