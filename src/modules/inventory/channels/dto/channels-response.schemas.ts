import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

export const invChannelSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  safetyBuffer: z.string().nullable(),
  publishThreshold: z.string().nullable(),
  warehouseIds: z.array(z.number().int()).nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listChannelsResponseSchema = z.array(invChannelSchema);

export const syncStockResponseSchema = z.object({
  synced: z.number().int(),
  skipped: z.number().int(),
});

const publicationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  channelId: z.number().int(),
  productVariantId: z.number().int(),
  publishedQty: z.string(),
  availableQty: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  publishedAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listPublicationsResponseSchema = itemsPagedSchema(publicationSchema);

export const retryPublicationsResponseSchema = z.object({ retried: z.number().int() });

const tplConnectionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  provider: z.string(),
  status: z.string().optional(),
  externalWarehouseRef: z.string().nullable(),
  skuMapping: z.record(z.string(), z.string()).nullable(),
  lastSyncAt: wireDate().nullable(),
  lastSyncStatus: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listTplConnectionsResponseSchema = z.array(tplConnectionSchema);

export const tplConnectionResponseSchema = tplConnectionSchema;

export const syncTplConnectionResponseSchema = z.object({
  connectionId: z.number().int(),
  status: z.string(),
  message: z.string().optional(),
});

/**
 * E6 — a snapshot difference as the operator's list returns it.
 *
 * The three quantities are `decimal` columns, so postgres-js hands them over as
 * exact strings; `difference` is signed, because a channel holding less than
 * the ledger and a channel holding more are opposite corrections.
 */
const snapshotDiffSchema = z.object({
  id: z.number().int(),
  externalSku: z.string(),
  productVariantId: z.number().int().nullable(),
  channelQty: z.string(),
  internalQty: z.string(),
  difference: z.string(),
  status: z.string(),
  snapshotAt: wireDate(),
  resolvedAt: nullableWireDate(),
  resolutionNote: z.string().nullable(),
  stockTransactionId: z.number().int().nullable(),
});

/**
 * `snapshotPolicy` rides along with the page so a screen can render "accepting
 * is not permitted here" instead of offering a button that 409s.
 */
export const listSnapshotDiffsResponseSchema = itemsPagedSchema(snapshotDiffSchema).extend({
  snapshotPolicy: z.string(),
});

/** `stockTransactionId` is null when the engine posted nothing new — a replay. */
export const acceptSnapshotDiffResponseSchema = z.object({
  diffId: z.number().int(),
  stockTransactionId: z.number().int().nullable(),
});

export const dismissSnapshotDiffResponseSchema = z.object({
  diffId: z.number().int(),
});

/** `SnapshotSweepResult` (`lib/channel-snapshot-context.ts`) — the drain's tally. */
export const channelSnapshotSweepResponseSchema = z.object({
  claimed: z.number().int(),
  refetched: z.number().int(),
  differencesRecorded: z.number().int(),
  retried: z.number().int(),
  dead: z.number().int(),
});

/**
 * The inbound webhook's acknowledgement. `duplicate` is absent rather than
 * false on a first delivery — a marketplace replaying one has done nothing
 * wrong and is told so, which is what stops it retrying harder.
 */
export const channelInboundResponseSchema = z.object({
  accepted: z.boolean(),
  duplicate: z.boolean().optional(),
});
