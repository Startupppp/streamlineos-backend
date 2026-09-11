import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

export const invSettingsResponseSchema = z.object({
  allowNegativeStock: z.boolean(),
  allowBackorders: z.boolean(),
  reservationStrategy: z.string(),
  defaultCostingMethod: z.string(),
  expiryReservationPolicy: z.string(),
  inspectionOnReceipt: z.boolean(),
  inspectionOnReturn: z.boolean(),
  overReceiptTolerancePct: z.string(),
  requirePoApproval: z.boolean(),
  adjustmentApprovalThreshold: z.string().nullable(),
  autoReserveOnConfirm: z.boolean(),
  allowPartialShipment: z.boolean(),
  packageRequiredForShipping: z.boolean(),
  channelPublishPolicy: z.string().nullable(),
});

const numberSequenceSchema = z.object({
  id: z.number().int().optional(),
  orgId: z.string().optional(),
  docType: z.string(),
  prefix: z.string(),
  nextNumber: z.number().int(),
  padding: z.number().int(),
  isDefault: z.boolean(),
  createdAt: wireDate().optional(),
  updatedAt: wireDate().optional(),
});

export const listNumberSequencesResponseSchema = z.array(numberSequenceSchema);

export const updateNumberSequenceResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  docType: z.string(),
  prefix: z.string(),
  nextNumber: z.number().int(),
  padding: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const healthResponseSchema = z.object({
  ledgerReconciliation: z.object({
    sampleSize: z.number().int(),
    transactionCount: z.number().int(),
    status: z.string(),
  }),
  activeExpiredReservations: z.number().int(),
  failedImportJobs: z.number().int(),
  failedExportJobs: z.number().int(),
  failedWebhookEvents: z.number().int(),
  failedChannelPublications: z.number().int(),
});

export const expireReservationsResponseSchema = z.object({
  expired: z.number().int(),
});
