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

export const vendorPerformanceResponseSchema = z.object({
  vendorId: z.number().int(),
  onTimeRate: z.number(),
  fillRate: z.number(),
  avgLeadTimeDays: z.number(),
  returnRate: z.number(),
  openPoCount: z.number().int(),
  totalSpend: z.number(),
});
