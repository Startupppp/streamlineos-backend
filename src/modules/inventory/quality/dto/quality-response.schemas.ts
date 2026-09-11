import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const userRefSchema = z.object({ id: z.string(), name: z.string().nullable() });

export const invQualityHoldSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  productVariantId: z.number().int(),
  locationId: z.number().int().nullable(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  quantity: z.string(),
  reason: z.string(),
  status: z.string(),
  releasedBy: z.string().nullable(),
  releasedByMembershipId: z.number().int().nullable(),
  releasedAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const holdEnrichedSchema = invQualityHoldSchema.extend({
  variantName: z.string().optional(),
  variantSku: z.string().optional(),
  productName: z.string().optional(),
});

export const listHoldsResponseSchema = itemsPagedSchema(holdEnrichedSchema);

const inspectionLineSchema = z.object({
  id: z.number().int(),
  inspectionId: z.number().int(),
  productVariantId: z.number().int(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  quantity: z.string(),
  result: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.string().optional(),
});

const inspectionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  inspectionNumber: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  status: z.string(),
  inspectorUserId: z.string().nullable(),
  inspectorMembershipId: z.number().int().nullable(),
  notes: z.string().nullable(),
  completedAt: wireDate().nullable(),
  cancelledAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(inspectionLineSchema).optional(),
});

export const listInspectionsResponseSchema = itemsPagedSchema(inspectionSchema);

export const createInspectionResponseSchema = inspectionSchema;

const recallLineSchema = z.object({
  id: z.number().int(),
  recallId: z.number().int(),
  productVariantId: z.number().int().nullable(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  status: z.string(),
});

export const invRecallSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  recallNumber: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  closedAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listRecallsResponseSchema = itemsPagedSchema(invRecallSchema);

export const getRecallResponseSchema = invRecallSchema.extend({
  lines: z.array(recallLineSchema),
  affectedShipments: z.array(z.object({ shipmentId: z.number().int(), shipmentNumber: z.string() })),
});

export const createRecallResponseSchema = invRecallSchema;

/**
 * D3 — a plan is the stable identity a SKU is matched against; a version is the
 * rule that plan carried at a point in time. They are separate shapes here for
 * the same reason they are separate rows: an inspection records the version, so
 * the standard a result was judged against stays legible after somebody tightens
 * the sampling.
 */
const inspectionPlanVersionSchema = z.object({
  id: z.number().int(),
  version: z.number().int(),
  samplingMethod: z.string(),
  /** Percent for PERCENTAGE, an absolute quantity for FIXED_QUANTITY, null for ALL. */
  sampleValue: z.string().nullable(),
  instructions: z.string().nullable(),
  status: z.string(),
  activatedAt: wireDate().nullable(),
  createdAt: wireDate(),
});

export const listInspectionPlansResponseSchema = itemsPagedSchema(
  z.object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    productVariantId: z.number().int().nullable(),
    productId: z.number().int().nullable(),
    categoryId: z.number().int().nullable(),
    appliesOnReceipt: z.boolean(),
    appliesOnReturn: z.boolean(),
    isActive: z.boolean(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
    /** The live rule, flattened out of the `versions` relation — null while none is published. */
    activeVersion: inspectionPlanVersionSchema
      .pick({ id: true, version: true, samplingMethod: true, sampleValue: true })
      .nullable(),
    scopeLabel: z.string(),
  }),
);

export const getInspectionPlanResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  productVariantId: z.number().int().nullable(),
  productId: z.number().int().nullable(),
  categoryId: z.number().int().nullable(),
  appliesOnReceipt: z.boolean(),
  appliesOnReturn: z.boolean(),
  isActive: z.boolean(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: wireDate().nullable(),
  versions: z.array(inspectionPlanVersionSchema),
});

export const listInspectionPlanVersionsResponseSchema = z.array(inspectionPlanVersionSchema);

/** Soft delete, so the answer names what was retired rather than returning the row. */
export const removeInspectionPlanResponseSchema = z.object({
  deleted: z.literal(true),
  planId: z.number().int(),
});

export const addInspectionPlanVersionResponseSchema = z.object({
  planId: z.number().int(),
  versionId: z.number().int(),
});

/**
 * D4 — `RecallImpact`, the read-only blast radius.
 *
 * Every quantity is a decimal string and every date is text the query produced
 * with `to_char`, so nothing here is a `Date` at the interceptor.
 */
export const simulateRecallResponseSchema = z.object({
  /** The question, echoed, so a stored evidence snapshot is self-describing. */
  selection: z.object({
    lotIds: z.array(z.number().int()).optional(),
    productVariantIds: z.array(z.number().int()).optional(),
    vendorId: z.number().int().optional(),
    manufacturedFrom: z.string().optional(),
    manufacturedTo: z.string().optional(),
    expiryFrom: z.string().optional(),
    expiryTo: z.string().optional(),
  }),
  warehouseScope: z.string(),
  lots: z.array(
    z.object({
      lotId: z.number().int(),
      lotNumber: z.string(),
      productVariantId: z.number().int(),
      variantSku: z.string(),
      variantName: z.string(),
      status: z.string(),
      manufactureDate: z.string().nullable(),
      expiryDate: z.string().nullable(),
    }),
  ),
  onHand: z.array(
    z.object({
      lotId: z.number().int(),
      locationId: z.number().int(),
      locationName: z.string(),
      warehouseId: z.number().int(),
      warehouseName: z.string(),
      onHand: z.string(),
      qualityHold: z.string(),
    }),
  ),
  inTransit: z.array(
    z.object({
      lotId: z.number().int(),
      transferId: z.number().int(),
      referenceNumber: z.string(),
      status: z.string(),
      quantity: z.string(),
      fromLocationId: z.number().int(),
      toLocationId: z.number().int(),
    }),
  ),
  shipped: z.array(
    z.object({
      lotId: z.number().int(),
      shipmentId: z.number().int(),
      shipmentNumber: z.string(),
      status: z.string(),
      shippedAt: z.string().nullable(),
      salesOrderId: z.number().int().nullable(),
      salesOrderNumber: z.string().nullable(),
      quantity: z.string(),
    }),
  ),
  returned: z.array(
    z.object({
      lotId: z.number().int(),
      returnId: z.number().int(),
      returnNumber: z.string(),
      status: z.string(),
      quantity: z.string(),
    }),
  ),
  totals: z.object({
    lots: z.number().int(),
    onHand: z.string(),
    onQualityHold: z.string(),
    inTransit: z.string(),
    shipped: z.string(),
    returned: z.string(),
  }),
  /** A content hash: an execute presenting a stale picture is refused against it. */
  evidenceVersion: z.string(),
});
