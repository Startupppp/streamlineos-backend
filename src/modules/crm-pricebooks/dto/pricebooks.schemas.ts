import { z } from "zod";

export const createPricebookSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  currency: z.string().default("INR"),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const updatePricebookSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  currency: z.string().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const upsertEntrySchema = z.object({
  productId: z.number().int().positive(),
  unitPriceCents: z.number().int().min(0),
  minQuantity: z.number().int().min(1).default(1),
});

export const resolvePriceQuerySchema = z.object({
  productId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().min(0).default(1),
  pricebookId: z.string().optional(),
});

export const quoteSettingsSchema = z.object({
  maxDiscountPercent: z.number().int().min(0).max(100).nullable().optional(),
  requirePricebookPrice: z.boolean().optional(),
  defaultExpiryDays: z.number().int().min(1).max(365).optional(),
  allowPriceOverride: z.boolean().optional(),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  isDefault: z.boolean().default(false),
  branding: z.record(z.unknown()).optional(),
  terms: z.string().optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isDefault: z.boolean().optional(),
  branding: z.record(z.unknown()).optional(),
  terms: z.string().optional(),
});

export type CreatePricebookInput = z.infer<typeof createPricebookSchema>;
export type UpdatePricebookInput = z.infer<typeof updatePricebookSchema>;
export type UpsertEntryInput = z.infer<typeof upsertEntrySchema>;
export type ResolvePriceQuery = z.infer<typeof resolvePriceQuerySchema>;
export type QuoteSettingsInput = z.infer<typeof quoteSettingsSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
