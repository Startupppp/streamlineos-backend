import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

/**
 * INV-26 widened this, and what it deliberately does NOT carry is the point:
 * `api_credential_encrypted` and `webhook_secret_encrypted` have no field here
 * and no field in `CARRIER_COLUMNS`, so the strongest statement this API can
 * make about a courier key is that one exists and ends in four known
 * characters.
 */
export const invCarrierSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  code: z.string(),
  trackingUrlTemplate: z.string().nullable(),
  isActive: z.boolean(),
  /** Which registered adapter speaks for this carrier; null means nobody. */
  transport: z.string().nullable(),
  apiBaseUrl: z.string().nullable(),
  /** "****3f9a". Never enough to reconstruct the key. */
  apiCredentialHint: z.string().nullable(),
  webhookSecretSet: z.boolean(),
  /** The last callback that failed verification — a visible failure state. */
  webhookLastFailureAt: wireDate().nullable(),
  webhookFailureReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listCarriersResponseSchema = z.array(invCarrierSchema);

const shipmentLineSchema = z.object({
  id: z.number().int(),
  shipmentId: z.number().int(),
  soLineId: z.number().int().nullable(),
  productVariantId: z.number().int(),
  quantity: z.string(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
});

const packageLineSchema = z.object({
  id: z.number().int(),
  packageId: z.number().int(),
  productVariantId: z.number().int(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  quantity: z.string(),
});

export const invShipmentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  shipmentNumber: z.string(),
  soId: z.number().int().nullable(),
  warehouseId: z.number().int().nullable(),
  carrierId: z.number().int().nullable(),
  trackingNumber: z.string().nullable(),
  status: z.string(),
  shippedAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  cancelledAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listShipmentsResponseSchema = itemsPagedSchema(invShipmentSchema);

export const invPackageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  packageNumber: z.string(),
  shipmentId: z.number().int().nullable(),
  weight: z.string().nullable(),
  dimensionsL: z.string().nullable(),
  dimensionsW: z.string().nullable(),
  dimensionsH: z.string().nullable(),
  status: z.string().optional(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(packageLineSchema).optional(),
});

export const getShipmentResponseSchema = invShipmentSchema.extend({
  lines: z.array(shipmentLineSchema),
  packages: z.array(invPackageSchema),
});

export const listPackagesResponseSchema = itemsPagedSchema(invPackageSchema);

export const getPackageResponseSchema = invPackageSchema;

const loadLineSchema = z.object({
  id: z.number().int(),
  loadId: z.number().int(),
  shipmentId: z.number().int().nullable(),
  transferId: z.number().int().nullable(),
});

export const invLoadSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  loadNumber: z.string(),
  sourceWarehouseId: z.number().int().nullable(),
  destination: z.string().nullable(),
  carrierId: z.number().int().nullable(),
  vehicleRef: z.string().nullable(),
  status: z.string(),
  dispatchDate: z.string().nullable(),
  arrivalDate: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  cancelledAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(loadLineSchema).optional(),
});

export const listLoadsResponseSchema = itemsPagedSchema(invLoadSchema);

export const getLoadResponseSchema = invLoadSchema;

/**
 * INV-207 — a carrier event, folded in.
 *
 * `recorded` says the event was stored; `advanced` says it moved the shipment.
 * The two are separate because a carrier routinely sends OUT_FOR_DELIVERY after
 * DELIVERED, and that event is kept and ignored rather than applied.
 */
export const recordCarrierStatusResponseSchema = z.object({
  recorded: z.boolean(),
  advanced: z.boolean(),
  status: z.string(),
});

export const shipmentTimelineResponseSchema = z.object({
  shipment: z.object({
    id: z.number().int(),
    status: z.string(),
    trackingNumber: z.string().nullable(),
  }),
  events: z.array(
    z.object({
      id: z.number().int(),
      status: z.string(),
      occurredAt: wireDate(),
      receivedAt: wireDate(),
      description: z.string().nullable(),
    }),
  ),
});

/**
 * B7 — asking the carrier where the parcel is. It answers rather than throws:
 * `polled: false` is the manual adapter's normal reply, and an unreachable
 * courier is a dead letter rather than a failed request.
 */
export const refreshTrackingResponseSchema = z.object({
  shipmentId: z.number().int(),
  carrier: z.string(),
  polled: z.boolean(),
  /** Events the carrier returned that we had not already recorded. */
  recorded: z.number().int(),
  status: z.string(),
  deadLettered: z.boolean(),
  error: z.string().optional(),
});

/**
 * INV-206 — advisory carton selection. A volumetric and longest-edge check, not
 * three-dimensional packing, so `recommended` is null whenever nothing fits or
 * too much is unmeasured to say.
 */
const cartonCandidateSchema = z.object({
  cartonTypeId: z.number().int(),
  code: z.string(),
  name: z.string(),
  capacityWeightGrams: z.number().int(),
  capacityVolumeMm3: z.number().int(),
  fits: z.boolean(),
  /** Why not, when it does not. */
  reasons: z.array(z.string()),
});

export const suggestCartonResponseSchema = z.object({
  totalWeightGrams: z.number(),
  totalVolumeMm3: z.number(),
  /** Any of these and the totals above are lower bounds, not the real thing. */
  unmeasuredVariantIds: z.array(z.number().int()),
  recommended: cartonCandidateSchema.nullable(),
  candidates: z.array(cartonCandidateSchema),
});

/** B6 — the queue the packing bench reads, off the cartons and the picks. */
export const packingQueueResponseSchema = itemsPagedSchema(
  z.object({
    soId: z.number().int(),
    soNumber: z.string(),
    status: z.string(),
    orderDate: z.string(),
    warehouseId: z.number().int().nullable(),
    customerName: z.string().nullable(),
    pickedQuantity: z.string(),
    packedQuantity: z.string(),
    packageCount: z.number().int(),
    openPackageCount: z.number().int(),
    openPackageId: z.number().int().nullable(),
    fullyPacked: z.boolean(),
  }),
);

/**
 * What came off the shelf, what went in the boxes, and what is left. `soId` is
 * null when the carton is not packing a sales order, and the three lists are
 * then empty because there is nothing to reconcile against.
 */
const reconciliationLineSchema = z.object({
  productVariantId: z.number().int(),
  quantity: z.string(),
});

export const packageReconciliationResponseSchema = z.object({
  soId: z.number().int().nullable(),
  picked: z.array(reconciliationLineSchema),
  packed: z.array(reconciliationLineSchema),
  outstanding: z.array(reconciliationLineSchema),
});
