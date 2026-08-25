import { z } from "zod";
import { SUPPORTED_DATE_FORMATS } from "../statement-csv";

/* ------------------------------------------------------------- primitives */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code");

/** A decimal amount as typed, parsed to minor units by the importer. */
const decimalAmount = z.string().min(1).max(32);

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  // Hard cap, per backend/CLAUDE.md §3.
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
};

const identifierScheme = z.enum([
  "IFSC_ACCOUNT",
  "IBAN",
  "ROUTING_ACCOUNT",
  "SORT_ACCOUNT",
  "BSB_ACCOUNT",
  "UPI",
  "OTHER",
]);

/**
 * The column mapping.
 *
 * `dateFormat` is required at the point a file is actually read; it is optional
 * here only so a partial mapping can be layered over a preset. The service
 * rejects a resolved mapping that still has no format — `03/04/2026` is 3 April
 * under DD/MM and 4 March under MM/DD, and nothing in this system guesses.
 */
export const csvMappingSchema = z
  .object({
    dateColumn: z.string().min(1).max(120).optional(),
    descriptionColumn: z.string().min(1).max(120).optional(),
    referenceColumn: z.string().min(1).max(120).optional(),
    amountColumn: z.string().min(1).max(120).optional(),
    debitColumn: z.string().min(1).max(120).optional(),
    creditColumn: z.string().min(1).max(120).optional(),
    dateFormat: z.enum(SUPPORTED_DATE_FORMATS).optional(),
    skipRows: z.number().int().min(0).max(100).optional(),
    delimiter: z.string().length(1).optional(),
    decimalSeparator: z.enum([".", ","]).optional(),
  })
  .strict();

/* --------------------------------------------------------- bank accounts */

export const createBankAccountSchema = z
  .object({
    bookId: z.string().min(1).max(64).optional(),
    accountId: z.string().min(1).max(64),
    displayName: z.string().min(1).max(160),
    bankName: z.string().min(1).max(160).optional(),
    currency: currencyCode.optional(),
    countryCode: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    identifierScheme: identifierScheme.optional(),
    identifierValue: z.string().min(1).max(64).optional(),
    branchIdentifier: z.string().min(1).max(64).optional(),
    csvMappingPreset: z.string().min(1).max(64).optional(),
    csvMapping: csvMappingSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateBankAccountBody = z.infer<typeof createBankAccountSchema>;

export const updateBankAccountSchema = z
  .object({
    displayName: z.string().min(1).max(160).optional(),
    bankName: z.string().max(160).nullable().optional(),
    countryCode: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    identifierScheme: identifierScheme.nullable().optional(),
    identifierValue: z.string().max(64).nullable().optional(),
    branchIdentifier: z.string().max(64).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateBankAccountBody = z.infer<typeof updateBankAccountSchema>;

export const saveCsvMappingSchema = z
  .object({
    preset: z.string().min(1).max(64).optional(),
    mapping: csvMappingSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.preset ?? v.mapping), {
    message: "Provide a mapping preset or an explicit column mapping",
  });
export type SaveCsvMappingBody = z.infer<typeof saveCsvMappingSchema>;

export const listBankAccountsQuerySchema = z
  .object({
    bookId: z.string().min(1).max(64).optional(),
    includeInactive: z.coerce.boolean().optional(),
    ...pagination,
  })
  .strict();
export type ListBankAccountsQuery = z.infer<typeof listBankAccountsQuerySchema>;

export const balanceQuerySchema = z.object({ asOf: isoDate }).strict();
export type BalanceQuery = z.infer<typeof balanceQuerySchema>;

/* -------------------------------------------------------------- statements */

/**
 * The file arrives as a string in the JSON body. No multipart, no upload
 * dependency, no temp files — a CSV is text, and the hash of that text is what
 * stops the same export landing twice.
 */
export const importStatementSchema = z
  .object({
    bankProfileId: z.string().min(1).max(64),
    content: z.string().min(1).max(8_000_000),
    fileName: z.string().min(1).max(255).optional(),
    presetCode: z.string().min(1).max(64).optional(),
    mapping: csvMappingSchema.optional(),
    periodStart: isoDate,
    periodEnd: isoDate,
    opening: decimalAmount,
    closing: decimalAmount,
  })
  .strict();
export type ImportStatementBody = z.infer<typeof importStatementSchema>;

export const listStatementsQuerySchema = z
  .object({
    bankProfileId: z.string().min(1).max(64).optional(),
    ...pagination,
  })
  .strict();
export type ListStatementsQuery = z.infer<typeof listStatementsQuerySchema>;

export const statementLinesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();
export type StatementLinesQuery = z.infer<typeof statementLinesQuerySchema>;

/* ---------------------------------------------------------------- matching */

export const matchCounterpartSchema = z
  .object({
    kind: z.enum(["receipt", "payment", "journal"]),
    id: z.string().min(1).max(64),
  })
  .strict();
export type MatchCounterpartBody = z.infer<typeof matchCounterpartSchema>;

export const suggestionsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(10) })
  .strict();
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;

export const unreconciledQuerySchema = z
  .object({
    bookId: z.string().min(1).max(64).optional(),
    accountId: z.string().min(1).max(64),
    asOf: isoDate,
    ...pagination,
  })
  .strict();
export type UnreconciledQuery = z.infer<typeof unreconciledQuerySchema>;
