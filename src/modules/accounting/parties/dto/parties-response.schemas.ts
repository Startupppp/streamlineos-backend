import { z } from "zod";
import { taxRegimeEnum } from "../../../../db/schema";

/** The party master's wire shapes, transcribed from `parties.types.ts`. */

const partySummarySchema = z.object({
  id: z.string(),
  bookId: z.string(),
  role: z.enum(["customer", "vendor", "both"]),
  displayName: z.string(),
  legalName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  countryCode: z.string(),
  defaultCurrency: z.string(),
  billingRegion: z.string().nullable(),
  billingCountryCode: z.string().nullable(),
  paymentTermsDays: z.number().int(),
  isActive: z.boolean(),
});

const partyTaxRegistrationSchema = z.object({
  id: z.string(),
  regime: z.enum(taxRegimeEnum.enumValues),
  number: z.string(),
  region: z.string().nullable(),
  countryCode: z.string(),
  isPrimary: z.boolean(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
});

const partyDetailSchema = partySummarySchema.extend({
  billingLine1: z.string().nullable(),
  billingLine2: z.string().nullable(),
  billingCity: z.string().nullable(),
  billingPostalCode: z.string().nullable(),
  shippingLine1: z.string().nullable(),
  shippingCity: z.string().nullable(),
  shippingRegion: z.string().nullable(),
  shippingPostalCode: z.string().nullable(),
  shippingCountryCode: z.string().nullable(),
  defaultIncomeAccountId: z.string().nullable(),
  defaultExpenseAccountId: z.string().nullable(),
  withholdingCode: z.string().nullable(),
  notes: z.string().nullable(),
  /** Pointers back at whatever owns this identity elsewhere — CRM, usually. */
  externalRefs: z.array(z.object({ system: z.string(), id: z.string() })),
  taxRegistrations: z.array(partyTaxRegistrationSchema),
});

export const getPartyResponseSchema = partyDetailSchema;
export const createPartyResponseSchema = partyDetailSchema;
export const updatePartyResponseSchema = partyDetailSchema;
/** The upsert CRM calls: twice for one company gives the same party back. */
export const resolvePartyResponseSchema = partyDetailSchema;

/** The list projects the summary, so it carries neither refs nor registrations. */
export const listPartiesResponseSchema = z.object({
  items: z.array(partySummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const listPartyRegistrationsResponseSchema = z.array(partyTaxRegistrationSchema);
export const addPartyRegistrationResponseSchema = partyTaxRegistrationSchema;

const deletedSchema = z.object({ id: z.string(), deleted: z.literal(true) });

export const removePartyResponseSchema = deletedSchema;
export const removePartyRegistrationResponseSchema = deletedSchema;
