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
