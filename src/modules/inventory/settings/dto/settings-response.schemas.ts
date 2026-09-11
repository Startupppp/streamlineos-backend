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

/**
 * E1 — which packs this organisation runs. Behind the read key rather than the
 * administration one, because the packs decide which fields the form renders.
 */
export const getPacksResponseSchema = z.object({
  warehouse: z.boolean(),
  kirana: z.boolean(),
  pharmacy: z.boolean(),
  gst: z.boolean(),
  materials: z.boolean(),
  quickCommerce: z.boolean(),
});

/**
 * D2 — the minimum-shelf-life contracts. `scope` is derived from `clientId`
 * rather than stored: the house floor is the row with no customer on it.
 */
export const listShelfLifeRulesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      clientId: z.number().int().nullable(),
      /** Left-joined through the Party map; null when the customer has no party row. */
      clientName: z.string().nullable(),
      minShelfLifeDays: z.number().int(),
      notes: z.string().nullable(),
      updatedAt: wireDate(),
      scope: z.string(),
    }),
  ),
});

/**
 * One PUT, two outcomes. A floor of zero clears the rule, and the cleared answer
 * carries no row because there is no longer one — `cleared` is the discriminator.
 */
export const putShelfLifeRuleResponseSchema = z.union([
  z.object({
    clientId: z.number().int().nullable(),
    minShelfLifeDays: z.literal(0),
    cleared: z.literal(true),
  }),
  z.object({
    id: z.number().int(),
    clientId: z.number().int().nullable(),
    minShelfLifeDays: z.number().int(),
    notes: z.string().nullable(),
    scope: z.string(),
    cleared: z.literal(false),
  }),
]);
