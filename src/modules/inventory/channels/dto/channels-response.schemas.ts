import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
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
