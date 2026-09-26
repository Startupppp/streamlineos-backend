import { z } from "zod";
import { DB_ENUMS } from "../../../../db/enums.generated";

/**
 * Boundary validation for the ledger kernel.
 *
 * Money crosses the wire as a whole number of **minor units** and is validated
 * as such — a client that sends `118.50` gets a 400, not a silently truncated
 * journal. Every schema is `.strict()` so an unexpected key is a rejection
 * rather than a field that quietly does nothing.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD");

const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 code such as INR");

const minorUnits = z
  .number()
  .int("Amounts are whole minor units (paise, cents) — not a decimal")
  .nonnegative();

const positiveMinorUnits = z
  .number()
  .int("Amounts are whole minor units (paise, cents) — not a decimal")
  .positive();

const decimalRate = z
  .string()
  .regex(/^\d+(\.\d{1,10})?$/, "Rate must be a positive decimal with at most 10 decimal places");

const uuid = z.string().min(1);

export const accountTypeSchema = z.enum([
  "ASSET",
  "CONTRA_ASSET",
  "LIABILITY",
  "CONTRA_LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
]);

export const systemTagSchema = z.enum(DB_ENUMS.gl_system_tag);

export const journalSourceSchema = z.enum(DB_ENUMS.gl_journal_source);

/* ------------------------------------------------------------------ books */

export const enableAccountingSchema = z
  .object({
    countryCode: z.string().regex(/^[A-Za-z]{2}$/, "Expected an ISO 3166 country code"),
    baseCurrency: currencyCode.optional(),
    packCode: z.string().min(1).max(32).optional(),
    name: z.string().min(1).max(120).optional(),
    legalEntityId: uuid.optional(),
    openFrom: isoDate.optional(),
  })
  .strict();
export type EnableAccountingInputDto = z.infer<typeof enableAccountingSchema>;

/* ------------------------------------------------------- chart of accounts */

export const createAccountSchema = z
  .object({
    code: z.string().min(1).max(32),
    name: z.string().min(1).max(160),
    accountType: accountTypeSchema,
    parentAccountId: uuid.nullish(),
    isHeader: z.boolean().optional(),
    isCash: z.boolean().optional(),
    systemTag: systemTagSchema.nullish(),
    currencyRestriction: currencyCode.nullish(),
    description: z.string().max(500).nullish(),
  })
  .strict();
export type CreateAccountInputDto = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    parentAccountId: uuid.nullish(),
    isActive: z.boolean().optional(),
    isCash: z.boolean().optional(),
    currencyRestriction: currencyCode.nullish(),
    description: z.string().max(500).nullish(),
  })
  .strict();
export type UpdateAccountInputDto = z.infer<typeof updateAccountSchema>;

export const setSystemTagSchema = z.object({ systemTag: systemTagSchema.nullable() }).strict();
export type SetSystemTagInputDto = z.infer<typeof setSystemTagSchema>;

export const listAccountsSchema = z
  .object({ includeInactive: z.coerce.boolean().optional() })
  .strict();
export type ListAccountsQueryDto = z.infer<typeof listAccountsSchema>;

/* ---------------------------------------------------------------- periods */

export const listPeriodsSchema = z.object({ fiscalYearId: uuid.optional() }).strict();
export type ListPeriodsQueryDto = z.infer<typeof listPeriodsSchema>;

export const lockPeriodSchema = z.object({ reason: z.string().max(500).optional() }).strict();
export type LockPeriodInputDto = z.infer<typeof lockPeriodSchema>;

/** Reopening is the audited one, so the reason is mandatory rather than optional. */
export const unlockPeriodSchema = z
  .object({ reason: z.string().min(3, "Say why this period is being reopened").max(500) })
  .strict();
export type UnlockPeriodInputDto = z.infer<typeof unlockPeriodSchema>;

/* --------------------------------------------------------------- journals */

export const postJournalLineSchema = z
  .object({
    accountId: uuid,
    debitMinor: minorUnits.optional(),
    creditMinor: minorUnits.optional(),
    txnCurrency: currencyCode.optional(),
    txnAmountMinor: positiveMinorUnits.optional(),
    fxRate: decimalRate.optional(),
    fxRateId: uuid.optional(),
    partyId: uuid.optional(),
    taxCodeId: uuid.optional(),
    taxComponent: z.string().max(32).optional(),
    dimensionBranchId: uuid.optional(),
    dimensionProjectId: z.number().int().positive().optional(),
    dimensionCostCenterId: z.string().max(64).optional(),
    description: z.string().max(500).optional(),
  })
  .strict()
  .refine(
    (line) => (line.debitMinor ?? 0) > 0 !== ((line.creditMinor ?? 0) > 0),
    "Exactly one of debit or credit must be greater than zero",
  );

export const postJournalSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    journalDate: isoDate,
    memo: z.string().max(500).optional(),
    sourceType: journalSourceSchema.default("manual"),
    sourceId: z.string().max(200).optional(),
    lines: z.array(postJournalLineSchema).min(1, "A journal needs at least one line"),
  })
  .strict();
export type PostJournalInputDto = z.infer<typeof postJournalSchema>;

export const reverseJournalSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    journalDate: isoDate.optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();
export type ReverseJournalInputDto = z.infer<typeof reverseJournalSchema>;

export const accountLedgerSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
export type AccountLedgerQueryDto = z.infer<typeof accountLedgerSchema>;

export const trialBalanceSchema = z.object({ asOf: isoDate }).strict();
export type TrialBalanceQueryDto = z.infer<typeof trialBalanceSchema>;

/* --------------------------------------------------------------------- FX */

export const upsertFxRateSchema = z
  .object({
    fromCode: currencyCode,
    toCode: currencyCode,
    rateDate: isoDate,
    rate: decimalRate,
    source: z.string().max(32).optional(),
  })
  .strict();
export type UpsertFxRateInputDto = z.infer<typeof upsertFxRateSchema>;

export const listFxRatesSchema = z
  .object({ from: currencyCode.optional(), to: currencyCode.optional() })
  .strict();
export type ListFxRatesQueryDto = z.infer<typeof listFxRatesSchema>;

export const enableCurrencySchema = z.object({ currencyCode }).strict();
export type EnableCurrencyInputDto = z.infer<typeof enableCurrencySchema>;

export const fxPreviewSchema = z
  .object({
    amountMinor: positiveMinorUnits,
    fromCode: currencyCode,
    toCode: currencyCode,
    onDate: isoDate,
  })
  .strict();
export type FxPreviewInputDto = z.infer<typeof fxPreviewSchema>;
