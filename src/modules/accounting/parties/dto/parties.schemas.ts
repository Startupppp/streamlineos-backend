import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";

/**
 * Payload schemas for the shared party master.
 *
 * A party is a customer, a vendor, or both — AR and AP consume the same rows,
 * so nothing here is AR-specific. Validation is Zod (backend/CLAUDE.md §2);
 * every object is `.strict()` so an unknown key is a 400 rather than a silent
 * drop.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

const currency = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code");

const countryCode = z.string().regex(/^[A-Z]{2}$/, "Expected an ISO 3166-1 alpha-2 country code");

export const partyRoleSchema = z.enum(["customer", "vendor", "both"]);

export const taxRegimeSchema = z.enum([
  "GST_IN",
  "VAT_EU",
  "VAT_GB",
  "VAT_GCC",
  "GST_SG",
  "GST_AU",
  "GST_HST_CA",
  "SALES_TAX_US",
  "PAN_IN",
  "TAN_IN",
  "EIN_US",
  "GENERIC",
]);

export const externalRefSchema = z
  .object({
    system: z.string().trim().min(1).max(64),
    id: z.string().trim().min(1).max(191),
  })
  .strict();

const addressFields = {
  billingLine1: z.string().trim().max(255).nullish(),
  billingLine2: z.string().trim().max(255).nullish(),
  billingCity: z.string().trim().max(120).nullish(),
  billingRegion: z.string().trim().max(64).nullish(),
  billingPostalCode: z.string().trim().max(32).nullish(),
  billingCountryCode: countryCode.nullish(),
  shippingLine1: z.string().trim().max(255).nullish(),
  shippingCity: z.string().trim().max(120).nullish(),
  shippingRegion: z.string().trim().max(64).nullish(),
  shippingPostalCode: z.string().trim().max(32).nullish(),
  shippingCountryCode: countryCode.nullish(),
};

const partyCoreFields = {
  role: partyRoleSchema.optional(),
  displayName: z.string().trim().min(1).max(255),
  legalName: z.string().trim().max(255).nullish(),
  email: z.string().trim().email().max(255).nullish(),
  phone: z.string().trim().max(64).nullish(),
  countryCode,
  defaultCurrency: currency,
  ...addressFields,
  defaultIncomeAccountId: z.string().trim().min(1).nullish(),
  defaultExpenseAccountId: z.string().trim().min(1).nullish(),
  paymentTermsDays: z.number().int().min(0).max(3650).optional(),
  withholdingCode: z.string().trim().max(32).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  isActive: z.boolean().optional(),
  externalRefs: z.array(externalRefSchema).max(20).optional(),
};

export const createPartySchema = z.object(partyCoreFields).strict();
export type CreatePartyInput = z.infer<typeof createPartySchema>;

export const updatePartySchema = z
  .object({
    ...partyCoreFields,
    displayName: z.string().trim().min(1).max(255).optional(),
    countryCode: countryCode.optional(),
    defaultCurrency: currency.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;

export const listPartiesSchema = z
  .object({
    role: partyRoleSchema.optional(),
    search: z.string().trim().max(191).optional(),
    includeInactive: queryBoolean.optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    /** Hard cap 100 per page (backend/CLAUDE.md §3). */
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ListPartiesQuery = z.infer<typeof listPartiesSchema>;

export const createTaxRegistrationSchema = z
  .object({
    regime: taxRegimeSchema,
    number: z.string().trim().min(1).max(64),
    region: z.string().trim().max(16).nullish(),
    countryCode,
    isPrimary: z.boolean().optional(),
    validFrom: isoDate.nullish(),
    validTo: isoDate.nullish(),
  })
  .strict();
export type CreateTaxRegistrationInput = z.infer<typeof createTaxRegistrationSchema>;

/**
 * Upsert-by-external-ref. This is what stops a CRM company becoming two
 * customers (PRD 07 acceptance 5): the pointer is the identity, and calling
 * this twice returns the same party.
 */
export const resolvePartySchema = z
  .object({
    externalRef: externalRefSchema,
    fields: z.object(partyCoreFields).strict(),
  })
  .strict();
export type ResolvePartyInput = z.infer<typeof resolvePartySchema>;
