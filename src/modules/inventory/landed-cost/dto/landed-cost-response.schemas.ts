import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

/**
 * G5 — landed cost.
 *
 * Two money grains sit on the same document and the schema keeps them apart.
 * `chargeTotalCents` and `amountCents` are `bigint` columns in integer minor
 * units, stringified by the service because a cent count past 2^53 is not a
 * JSON number; `capitalisedValue`, `expensedValue` and everything on an
 * allocation are `numeric(18,4)`, the grain cost layers are kept at, and arrive
 * as decimal strings from the driver. Both are strings on the wire, and neither
 * may be read as the other.
 */
const landedCostVoucherListRowSchema = z.object({
  id: z.number().int(),
  voucherNumber: z.string(),
  grnId: z.number().int(),
  status: z.string(),
  allocationBasis: z.string(),
  currency: z.string(),
  chargeTotalCents: z.string(),
  capitalisedValue: z.string(),
  expensedValue: z.string(),
  appliedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const listLandedCostVouchersResponseSchema = itemsPagedSchema(
  landedCostVoucherListRowSchema,
);

const landedCostChargeSchema = z.object({
  id: z.number().int(),
  chargeType: z.string(),
  description: z.string(),
  amountCents: z.string(),
  vendorId: z.number().int().nullable(),
  reference: z.string().nullable(),
});

/**
 * Where every fraction went. Empty until the voucher is applied, and
 * `valuationLayerId` is nullable because a share that could not capitalise
 * belongs to no layer.
 */
const landedCostAllocationSchema = z.object({
  valuationLayerId: z.number().int().nullable(),
  productVariantId: z.number().int(),
  costingMethod: z.string(),
  weight: z.string(),
  allocatedValue: z.string(),
  capitalisedValue: z.string(),
  expensedValue: z.string(),
  layerQuantity: z.string(),
  remainingQuantity: z.string(),
  unitCostBefore: z.string(),
  unitCostAfter: z.string(),
});

/** `chargeTotal` is `chargeTotalCents` restated at the cost layers' own grain. */
export const getLandedCostVoucherResponseSchema = z.object({
  id: z.number().int(),
  voucherNumber: z.string(),
  grnId: z.number().int(),
  status: z.string(),
  allocationBasis: z.string(),
  currency: z.string(),
  chargeTotalCents: z.string(),
  chargeTotal: z.string(),
  capitalisedValue: z.string(),
  expensedValue: z.string(),
  notes: z.string().nullable(),
  appliedAt: nullableWireDate(),
  createdAt: wireDate(),
  charges: z.array(landedCostChargeSchema),
  allocations: z.array(landedCostAllocationSchema),
});

export const createLandedCostVoucherResponseSchema = z.object({
  id: z.number().int(),
  voucherNumber: z.string(),
});

export const addLandedCostChargeResponseSchema = z.object({
  voucherId: z.number().int(),
  chargeTotalCents: z.string(),
});

/** `LandedCostApplyResult`. The status is a literal: apply has one outcome. */
export const applyLandedCostVoucherResponseSchema = z.object({
  voucherId: z.number().int(),
  status: z.literal("APPLIED"),
  chargeTotal: z.string(),
  capitalisedValue: z.string(),
  expensedValue: z.string(),
  layersRevalued: z.number().int(),
});

export const deleteLandedCostVoucherResponseSchema = z.object({
  deleted: z.literal(true),
});
