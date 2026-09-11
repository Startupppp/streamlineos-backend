import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const pricebookSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  currency: z.string(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const pricebookEntrySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  pricebookId: z.string(),
  productId: z.number().int(),
  unitPriceCents: z.number().int(),
  minQuantity: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const pricebookEntryWithProductSchema = z.object({
  id: z.string(),
  productId: z.number().int(),
  unitPriceCents: z.number().int(),
  minQuantity: z.number().int(),
  productName: z.string().nullable(),
  productSku: z.string().nullable(),
  productCurrency: z.string().nullable(),
});

export const resolvePriceSchema = z.object({
  unitPriceCents: z.number().int(),
  source: z.enum(["pricebook", "product"]),
  pricebookName: z.string().nullable(),
});

export const quoteSettingsSchema = z.object({
  id: z.string().optional(),
  orgId: z.string().optional(),
  maxDiscountPercent: z.number().int().nullable(),
  requirePricebookPrice: z.boolean(),
  defaultExpiryDays: z.number().int(),
  allowPriceOverride: z.boolean(),
  createdAt: wireDate().optional(),
  updatedAt: wireDate().optional(),
});

export const quoteTemplateSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  branding: z.record(z.string(), z.unknown()).nullable(),
  terms: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export { successSchema };
