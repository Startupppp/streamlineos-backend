import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";

/**
 * The banking wire shapes, transcribed from the service-level interfaces:
 * `BankAccountSummary`, `StatementImportResult`, `StatementSummary`,
 * `ReconciliationProof`, the matching views and `ExplainedLine`.
 *
 * `reconciliation/export` is not here: it is a CSV download, declared with
 * `@ApiOkResponse` the way every other export in the repo is.
 */

const bankIdentifierSchemeSchema = z.enum([
  "IFSC_ACCOUNT",
  "IBAN",
  "ROUTING_ACCOUNT",
  "SORT_ACCOUNT",
  "BSB_ACCOUNT",
  "UPI",
  "OTHER",
]);

/** Only the columns `bank_profiles.csv_mapping` persists; null until one is saved. */
const storedCsvMappingSchema = z
  .object({
    dateColumn: z.string().optional(),
    descriptionColumn: z.string().optional(),
    referenceColumn: z.string().optional(),
    amountColumn: z.string().optional(),
    debitColumn: z.string().optional(),
    creditColumn: z.string().optional(),
    dateFormat: z.string().optional(),
    skipRows: z.number().int().optional(),
  })
  .nullable();

const bankAccountSummarySchema = z.object({
  id: z.string(),
  bookId: z.string(),
  accountId: z.string(),
  accountCode: z.string(),
  accountName: z.string(),
  displayName: z.string(),
  bankName: z.string().nullable(),
  currency: z.string(),
  countryCode: z.string(),
  identifierScheme: bankIdentifierSchemeSchema.nullable(),
  identifierValue: z.string().nullable(),
  branchIdentifier: z.string().nullable(),
  csvMapping: storedCsvMappingSchema,
  isActive: z.boolean(),
});

export const getBankAccountResponseSchema = bankAccountSummarySchema;
export const createBankAccountResponseSchema = bankAccountSummarySchema;
export const updateBankAccountResponseSchema = bankAccountSummarySchema;
/** Saving a mapping re-reads the profile, so it answers with the summary. */
export const saveCsvMappingResponseSchema = bankAccountSummarySchema;

export const listBankAccountsResponseSchema = z.object({
  items: z.array(bankAccountSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

/** Derived from `gl_journal_lines` on every call — nothing is stored. */
export const bankAccountBalanceResponseSchema = z.object({
  bankProfileId: z.string(),
  accountId: z.string(),
  asOf: z.string(),
  functionalCurrency: z.string(),
  functionalBalanceMinor: z.number().int(),
  currency: z.string(),
  balanceMinor: z.number().int(),
});

/* ------------------------------------------------------------- statements */

const statementSummarySchema = z.object({
  id: z.string(),
  bankProfileId: z.string(),
  bookId: z.string(),
  currency: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  openingMinor: z.number().int(),
  closingMinor: z.number().int(),
  source: z.enum(["csv", "manual", "feed"]),
  fileName: z.string().nullable(),
  fileHash: z.string().nullable(),
  lineCount: z.number().int(),
  reconciledAt: nullableWireDate(),
  reconciledBy: z.string().nullable(),
  importedAt: wireDate(),
});

const importedStatementLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  valueDate: z.string(),
  amountMinor: z.number().int(),
  description: z.string().nullable(),
  bankReference: z.string().nullable(),
});

export const importStatementResponseSchema = z.object({
  statementId: z.string(),
  bankProfileId: z.string(),
  currency: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  openingMinor: z.number().int(),
  closingMinor: z.number().int(),
  movementMinor: z.number().int(),
  lineCount: z.number().int(),
  fileHash: z.string(),
  warnings: z.array(
    z.object({
      code: z.enum(["DUPLICATE_LINE", "ROW_SKIPPED", "LINE_OUTSIDE_PERIOD"]),
      message: z.string(),
    }),
  ),
  lines: z.array(importedStatementLineSchema),
});

export const listStatementsResponseSchema = z.object({
  items: z.array(statementSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const getStatementResponseSchema = statementSummarySchema.extend({
  lines: z.array(importedStatementLineSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
});

/** The shipped CSV layouts, as data, so a UI can render the picker from them. */
export const listMappingPresetsResponseSchema = z.object({
  presets: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      description: z.string(),
      mapping: z.object({
        dateColumn: z.string(),
        descriptionColumn: z.string().optional(),
        referenceColumn: z.string().optional(),
        amountColumn: z.string().optional(),
        debitColumn: z.string().optional(),
        creditColumn: z.string().optional(),
        dateFormat: z.string(),
        skipRows: z.number().int().optional(),
        delimiter: z.string().optional(),
        decimalSeparator: z.string().optional(),
      }),
    }),
  ),
});

/* ---------------------------------------------------------- the rec proof */

const unreconciledGlLineSchema = z.object({
  journalId: z.string(),
  journalNumber: z.string(),
  journalDate: z.string(),
  lineId: z.string(),
  lineNo: z.number().int(),
  accountId: z.string(),
  amountMinor: z.number().int(),
  txnCurrency: z.string(),
  functionalAmountMinor: z.number().int(),
  memo: z.string().nullable(),
  description: z.string().nullable(),
  sourceType: z.string(),
  sourceId: z.string().nullable(),
});

const unreconciledStatementLineSchema = z.object({
  id: z.string(),
  statementId: z.string(),
  lineNo: z.number().int(),
  valueDate: z.string(),
  amountMinor: z.number().int(),
  description: z.string().nullable(),
  bankReference: z.string().nullable(),
});

/** Every term of `G − Ugl = S − Ust`, so a reader can see why the two differ. */
export const reconciliationProofResponseSchema = z.object({
  statementId: z.string(),
  bankProfileId: z.string(),
  bookId: z.string(),
  accountId: z.string(),
  currency: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  glBalanceMinor: z.number().int(),
  statementClosingMinor: z.number().int(),
  unmatchedGlMinor: z.number().int(),
  unmatchedGlLines: z.array(unreconciledGlLineSchema),
  unmatchedStatementMinor: z.number().int(),
  unmatchedStatementLines: z.array(unreconciledStatementLineSchema),
  adjustedGlMinor: z.number().int(),
  adjustedStatementMinor: z.number().int(),
  differenceMinor: z.number().int(),
  holds: z.boolean(),
  openingVarianceMinor: z.number().int(),
  openingGlMinor: z.number().int(),
  statementOpeningMinor: z.number().int(),
  priorUnmatchedGlMinor: z.number().int(),
  functionalCurrency: z.string(),
  glBalanceFunctionalMinor: z.number().int(),
  explanation: z.string(),
  reconciledAt: nullableWireDate(),
  reconciledBy: z.string().nullable(),
});

/* ---------------------------------------------------------------- matching */

const matchKindSchema = z.enum(["receipt", "payment", "journal"]);

export const matchSuggestionsResponseSchema = z.object({
  line: z.object({
    id: z.string(),
    statementId: z.string(),
    lineNo: z.number().int(),
    valueDate: z.string(),
    amountMinor: z.number().int(),
    description: z.string().nullable(),
    bankReference: z.string().nullable(),
    profile: bankAccountSummarySchema,
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  suggestions: z.array(
    z.object({
      kind: matchKindSchema,
      id: z.string(),
      label: z.string(),
      date: z.string(),
      amountMinor: z.number().int(),
      currency: z.string(),
      reference: z.string().nullable(),
      score: z.number(),
      reasons: z.array(z.string()),
    }),
  ),
});

const recordedMatchSchema = z.object({
  id: z.string(),
  statementLineId: z.string(),
  kind: matchKindSchema,
  counterpartId: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  matchedAt: wireDate(),
});

export const matchStatementLineResponseSchema = recordedMatchSchema;

export const unmatchStatementLineResponseSchema = z.object({
  statementLineId: z.string(),
  removed: z.literal(true),
});

/** The journal and the match, written in one transaction or not at all. */
export const explainStatementLineResponseSchema = z.object({
  statementLineId: z.string(),
  journalId: z.string(),
  journalNumber: z.string(),
  match: recordedMatchSchema,
});

export const unreconciledResponseSchema = z.object({
  bookId: z.string(),
  accountId: z.string(),
  bankProfileId: z.string(),
  currency: z.string(),
  asOf: z.string(),
  statementLines: z.array(unreconciledStatementLineSchema),
  statementLinesTotalMinor: z.number().int(),
  glLines: z.array(unreconciledGlLineSchema),
  glLinesTotalMinor: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
