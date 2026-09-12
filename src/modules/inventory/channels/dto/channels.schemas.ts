import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { z } from "zod";

/**
 * Both id lists below reach Postgres as `inArray(...)`, so their length is a
 * bind-parameter count a caller sets — and postgres-js refuses a statement past
 * 65,534 of them outright. 500 is the gate's own reference bulk cap
 * (`check:bounded-contracts`, MAX_IDS_CAP), sits far above the warehouse count
 * or retry batch any real organisation has, and turns an unbounded fan-out into
 * a bounded one.
 */
const CHANNEL_BULK_IDS_MAX = 500;

export const createChannelSchema = z.object({
  name: z.string().min(1),
  channelType: z.enum(["INTERNAL", "SHOPIFY", "WOOCOMMERCE", "MARKETPLACE", "B2B", "THREE_PL"]),
  safetyBuffer: z.string().optional().default("0"),
  publishThreshold: z.string().optional(),
  warehouseIds: z.array(z.number().int()).max(CHANNEL_BULK_IDS_MAX).optional().default([]),
  settings: z.record(z.string(), z.unknown()).optional(),
  apiCredential: z.string().min(1).max(2000).optional(),
  webhookSecret: z.string().min(1).max(2000).optional(),
}).strict();
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  safetyBuffer: z.string().optional(),
  publishThreshold: z.string().optional(),
  warehouseIds: z.array(z.number().int()).max(CHANNEL_BULK_IDS_MAX).optional(),
  status: z.enum(["ACTIVE", "PAUSED"]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  apiCredential: z.string().min(1).max(2000).optional(),
  webhookSecret: z.string().min(1).max(2000).optional(),
}).strict();
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;


export const listPublicationsQuerySchema = z.object({
  status: z.enum(["PENDING", "PUBLISHED", "FAILED"]).optional(),
  page: pageNumberField,
  limit: pageSizeField(20, 100),
}).strict();
export type ListPublicationsQueryInput = z.infer<typeof listPublicationsQuerySchema>;

export const retryPublicationsSchema = z.object({
  productVariantIds: z.array(z.number().int()).max(CHANNEL_BULK_IDS_MAX).optional(),
}).strict();
export type RetryPublicationsInput = z.infer<typeof retryPublicationsSchema>;

export const create3plConnectionSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  externalWarehouseRef: z.string().optional(),
  skuMapping: z.record(z.string(), z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  apiCredential: z.string().min(1).max(2000).optional(),
  webhookSecret: z.string().min(1).max(2000).optional(),
}).strict();
export type Create3plConnectionInput = z.infer<typeof create3plConnectionSchema>;

export const update3plConnectionSchema = z.object({
  name: z.string().min(1).optional(),
  provider: z.string().optional(),
  externalWarehouseRef: z.string().optional(),
  skuMapping: z.record(z.string(), z.string()).optional(),
  status: z.enum(["DISCONNECTED", "CONNECTED", "ERROR"]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  apiCredential: z.string().min(1).max(2000).optional(),
  webhookSecret: z.string().min(1).max(2000).optional(),
}).strict();
export type Update3plConnectionInput = z.infer<typeof update3plConnectionSchema>;
