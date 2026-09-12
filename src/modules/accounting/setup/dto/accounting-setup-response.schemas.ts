import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import {
  glBookStatusEnum,
  glSystemTagEnum,
  taxRegimeEnum,
  taxRegistrationOwnerEnum,
} from "../../../../db/schema";

/**
 * Onboarding's wire shapes.
 *
 * `status` is genuinely two shapes — an org with no book answers
 * `{ enabled: false, provisioning }` and nothing else — so it is declared as
 * the union it is rather than as one object with everything optional, which
 * would describe a payload the service never produces.
 */

/**
 * Why a book cannot accept a posting, if it cannot. `not_requested` and `ready`
 * carry nothing beyond the state, which is why this is a union.
 */
const provisioningSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_requested") }),
  z.object({ state: z.literal("unprovisioned"), message: z.string() }),
  z.object({
    state: z.literal("incomplete"),
    bookId: z.string(),
    missingRoles: z.array(z.enum(glSystemTagEnum.enumValues)),
    message: z.string(),
  }),
  z.object({
    state: z.literal("fiscal_year_ending"),
    bookId: z.string(),
    endsOn: z.string(),
    daysRemaining: z.number().int(),
    message: z.string(),
  }),
  z.object({ state: z.literal("ready"), bookId: z.string() }),
]);

const packStatusSchema = z.enum(["enabled", "stub"]);

export const setupStatusResponseSchema = z.union([
  z.object({ enabled: z.literal(false), provisioning: provisioningSchema }),
  z.object({
    enabled: z.literal(true),
    book: z.object({
      id: z.string(),
      name: z.string(),
      countryCode: z.string(),
      baseCurrency: z.string(),
      localizationPack: z.string(),
      fiscalYearStartMonth: z.number().int(),
      fiscalYearStartDay: z.number().int(),
      timezone: z.string(),
      isDefault: z.boolean(),
      status: z.enum(glBookStatusEnum.enumValues),
    }),
    packStatus: packStatusSchema,
    accounts: z.number().int(),
    taxCodes: z.number().int(),
    taxRegistrations: z.number().int(),
    provisioning: provisioningSchema,
    nextSteps: z.array(z.string()),
  }),
]);

/** One call: book, chart, fiscal year, periods and the pack's tax codes. */
export const setupEnableResponseSchema = z.object({
  bookId: z.string(),
  name: z.string(),
  countryCode: z.string(),
  baseCurrency: z.string(),
  localizationPack: z.string(),
  packStatus: packStatusSchema,
  fiscalYear: z.object({
    id: z.string(),
    name: z.string(),
    startsOn: z.string(),
    endsOn: z.string(),
  }),
  accountsSeeded: z.number().int(),
  taxCodesSeeded: z.number().int(),
  nextSteps: z.array(z.string()),
});

/** The list projects six columns; the insert `.returning()`s the whole row. */
export const listTaxRegistrationsResponseSchema = z.array(
  z.object({
    id: z.string(),
    regime: z.enum(taxRegimeEnum.enumValues),
    number: z.string(),
    region: z.string().nullable(),
    countryCode: z.string(),
    isPrimary: z.boolean(),
  }),
);

export const addTaxRegistrationResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  ownerType: z.enum(taxRegistrationOwnerEnum.enumValues),
  bookId: z.string().nullable(),
  partyId: z.string().nullable(),
  regime: z.enum(taxRegimeEnum.enumValues),
  number: z.string(),
  region: z.string().nullable(),
  countryCode: z.string(),
  isPrimary: z.boolean(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** What the equity plug will absorb, before anything is written. */
export const openingBalancesPreviewResponseSchema = z.object({
  asOfDate: z.string(),
  journalDate: z.string(),
  totalDebitMinor: z.number().int(),
  totalCreditMinor: z.number().int(),
  differenceMinor: z.number().int(),
  balancingAccountCode: z.string().nullable(),
  currency: z.string(),
  alreadyPosted: z.boolean(),
});
