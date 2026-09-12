import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../../common/openapi/wire-types";

/**
 * INV-27 — what the channel-sync seam answers.
 *
 * Read off the service's own returns rather than off the tables: the enqueue
 * routes answer with what they queued, not with the row, because the row is a
 * job the caller never sees again. `ResponseContractInterceptor` compares each
 * of these against the value the handler actually produced, so a shape that
 * drifts fails a spec rather than a screen.
 */

const channelJobKindSchema = z.enum([
  "STOCK_PUSH",
  "STOCK_PULL",
  "ORDER_PULL",
  "ORDER_IMPORT",
  "SHIP_CONFIRM",
]);

/**
 * `ChannelCommerceRegistrar.describe` — what a screen should say about the
 * connection. `name` carries the honest empty-state sentence when no adapter is
 * configured, which is why it is never null.
 */
const channelConnectionSchema = z.object({
  connected: z.boolean(),
  real: z.boolean(),
  name: z.string(),
  problem: z.string().nullable(),
});

/**
 * `POST /inventory/channels/{channelId}/sync/stock`. Two jobs are enqueued, a
 * push and a pull, and `queued` names the ones the natural key actually
 * accepted — an empty list with `alreadyQueued: true` is the duplicate answer.
 */
export const enqueueStockSyncResponseSchema = z.object({
  queued: z.array(channelJobKindSchema),
  alreadyQueued: z.boolean(),
  connection: channelConnectionSchema,
});

/** `POST /inventory/channels/{channelId}/sync/orders`. */
export const enqueueOrderPullResponseSchema = z.object({
  queued: z.boolean(),
  alreadyQueued: z.boolean(),
});

/** `POST /inventory/channels/{channelId}/sync/shipments`. */
export const enqueueShipConfirmResponseSchema = z.object({
  queued: z.boolean(),
  alreadyConfirmed: z.boolean(),
});

/** `POST /inventory/channels/sync/failures/{jobId}/retry`. A miss is a 404. */
export const retryChannelJobResponseSchema = z.object({
  retried: z.literal(true),
  jobId: z.number().int(),
});

/**
 * `GET /inventory/channels/{channelId}/sync/failures` — the dead-letter screen.
 * The store projects exactly these columns; `request`, `response` and the lease
 * are deliberately not among them.
 */
export const listChannelFailuresResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      channelId: z.number().int(),
      kind: channelJobKindSchema,
      externalRef: z.string(),
      status: z.enum(["PENDING", "PROCESSED", "FAILED", "DEAD"]),
      attemptCount: z.number().int(),
      lastErrorCode: z.string().nullable(),
      lastError: z.string().nullable(),
      nextAttemptAt: wireDate(),
      deadLetteredAt: nullableWireDate(),
      createdAt: wireDate(),
      updatedAt: wireDate(),
    }),
  ),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
});

/**
 * `GET|POST /cron/inventory-channel-sync`. The drain's tally: `claimed` is how
 * many jobs the lease took this sweep, and the five counters are
 * `ChannelSyncOutcome`.
 */
export const channelSyncDrainResponseSchema = z.object({
  claimed: z.number().int(),
  succeeded: z.number().int(),
  retried: z.number().int(),
  dead: z.number().int(),
  enqueued: z.number().int(),
  duplicates: z.number().int(),
});
