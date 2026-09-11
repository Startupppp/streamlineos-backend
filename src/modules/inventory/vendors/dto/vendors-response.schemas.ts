import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

export const invVendorSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int().nullable(),
  name: z.string(),
  code: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  gstin: z.string().nullable(),
  leadTimeDays: z.number().int(),
  paymentTermsDays: z.number().int(),
  currency: z.string(),
  isActive: z.boolean(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listVendorsResponseSchema = itemsPagedSchema(invVendorSchema);

const scorecardRateSchema = z.object({
  percent: z.string().nullable(),
  numerator: z.string(),
  denominator: z.string(),
  sampleSize: z.number().int(),
  sufficient: z.boolean(),
});

/** `VendorScorecard` (`vendors/vendor-scorecard.service.ts`). */
export const vendorScorecardSchema = z.object({
  vendorId: z.number().int(),
  leadTime: z.object({
    observations: z.number().int(),
    meanDays: z.number(),
    stdDevDays: z.number(),
    p50Days: z.number(),
    p90Days: z.number(),
    reliable: z.boolean(),
    note: z.string().optional(),
  }),
  onTime: scorecardRateSchema,
  lineFill: scorecardRateSchema,
  unitFill: scorecardRateSchema,
  returns: scorecardRateSchema,
  rejection: scorecardRateSchema,
  discrepancy: scorecardRateSchema,
  openPoCount: z.number().int(),
  spend: z.object({
    amount: z.string(),
    currency: z.string(),
    excludedCurrencies: z.array(z.string()),
  }),
  notes: z.array(z.string()),
});

export const vendorPerformanceResponseSchema = vendorScorecardSchema;
