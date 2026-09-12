import { z } from "zod";
import { glAccountTypeEnum, taxGlRoleEnum } from "../../../../db/schema";

/**
 * The financial statements, transcribed from each service's own report
 * interface. Every figure is integer minor units in the book's base currency.
 *
 * `reportKey` is a literal on each one: it is how a reader tells which report a
 * payload is without inspecting its shape, and the services set it explicitly.
 *
 * The CSV route is not here — it writes to the `Response` itself and declares a
 * `text/csv` body with `@ApiOkResponse`.
 */

const accountTypeSchema = z.enum(glAccountTypeEnum.enumValues);
const labelModeSchema = z.enum(["founder", "accountant"]);

const fiscalYearWindowSchema = z.object({
  name: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  /** False when no `gl_fiscal_years` row covers the date and the span was derived. */
  opened: z.boolean(),
});

export const trialBalanceReportResponseSchema = z.object({
  reportKey: z.literal("trial_balance"),
  title: z.string(),
  labelMode: labelModeSchema,
  bookId: z.string(),
  currency: z.string(),
  asOf: z.string(),
  includeZeroActivity: z.boolean(),
  columns: z.object({ account: z.string(), debit: z.string(), credit: z.string() }),
  lines: z.array(
    z.object({
      accountId: z.string(),
      code: z.string(),
      name: z.string(),
      accountType: accountTypeSchema,
      accountTypeLabel: z.string(),
      debitMinor: z.number().int(),
      creditMinor: z.number().int(),
      movementDebitMinor: z.number().int(),
      movementCreditMinor: z.number().int(),
    }),
  ),
  totalDebitMinor: z.number().int(),
  totalCreditMinor: z.number().int(),
  balanced: z.boolean(),
  differenceMinor: z.number().int(),
  /** A dimension-filtered slice is not expected to balance; this says so. */
  filtered: z.boolean(),
  notes: z.array(z.string()),
});

const profitLossSectionSchema = z.object({
  key: z.enum(["income", "expense"]),
  label: z.string(),
  lines: z.array(
    z.object({
      accountId: z.string(),
      code: z.string(),
      name: z.string(),
      accountType: accountTypeSchema,
      amountMinor: z.number().int(),
      priorAmountMinor: z.number().int().nullable(),
      varianceMinor: z.number().int().nullable(),
    }),
  ),
  totalMinor: z.number().int(),
  priorTotalMinor: z.number().int().nullable(),
});

export const profitLossReportResponseSchema = z.object({
  reportKey: z.literal("profit_loss"),
  title: z.string(),
  labelMode: labelModeSchema,
  bookId: z.string(),
  currency: z.string(),
  /** What the caller asked for, kept so a fiscal-year clamp is never silent. */
  requestedFrom: z.string(),
  from: z.string(),
  to: z.string(),
  fiscalYear: fiscalYearWindowSchema,
  clampedToFiscalYear: z.boolean(),
  comparative: z.object({ from: z.string(), to: z.string() }).nullable(),
  columns: z.object({
    account: z.string(),
    thisPeriod: z.string(),
    lastPeriod: z.string(),
    change: z.string(),
  }),
  income: profitLossSectionSchema,
  expense: profitLossSectionSchema,
  netProfitLabel: z.string(),
  netProfitMinor: z.number().int(),
  priorNetProfitMinor: z.number().int().nullable(),
  notes: z.array(z.string()),
});

const balanceSheetSectionSchema = z.object({
  key: z.enum(["assets", "liabilities", "equity"]),
  label: z.string(),
  lines: z.array(
    z.object({
      /** Null on a computed line — there is no account behind it, by design. */
      accountId: z.string().nullable(),
      code: z.string().nullable(),
      name: z.string(),
      accountType: accountTypeSchema.nullable(),
      computed: z.boolean(),
      tag: z.enum(["current_year_earnings", "prior_year_earnings"]).nullable(),
      amountMinor: z.number().int(),
      isContra: z.boolean(),
    }),
  ),
  totalMinor: z.number().int(),
});

export const balanceSheetReportResponseSchema = z.object({
  reportKey: z.literal("balance_sheet"),
  title: z.string(),
  labelMode: labelModeSchema,
  bookId: z.string(),
  currency: z.string(),
  asOf: z.string(),
  fiscalYear: fiscalYearWindowSchema,
  assets: balanceSheetSectionSchema,
  liabilities: balanceSheetSectionSchema,
  equity: balanceSheetSectionSchema,
  totalAssetsMinor: z.number().int(),
  totalLiabilitiesMinor: z.number().int(),
  totalEquityMinor: z.number().int(),
  liabilitiesAndEquityMinor: z.number().int(),
  currentYearEarningsMinor: z.number().int(),
  priorYearEarningsMinor: z.number().int(),
  balanced: z.boolean(),
  differenceMinor: z.number().int(),
  notes: z.array(z.string()),
});

export const cashFlowReportResponseSchema = z.object({
  reportKey: z.literal("cash_flow"),
  title: z.string(),
  method: z.literal("indirect"),
  labelMode: labelModeSchema,
  bookId: z.string(),
  currency: z.string(),
  from: z.string(),
  to: z.string(),
  sections: z.array(
    z.object({
      key: z.enum(["operating", "non_cash", "working_capital", "unmodelled"]),
      label: z.string(),
      lines: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          amountMinor: z.number().int(),
          /** The accounts behind the figure, so a number can be traced. */
          accountCodes: z.array(z.string()),
        }),
      ),
      totalMinor: z.number().int(),
    }),
  ),
  netIncomeMinor: z.number().int(),
  nonCashMinor: z.number().int(),
  workingCapitalMinor: z.number().int(),
  operatingCashMinor: z.number().int(),
  otherMovementsMinor: z.number().int(),
  openingCashMinor: z.number().int(),
  netMovementMinor: z.number().int(),
  closingCashMinor: z.number().int(),
  reconciles: z.boolean(),
  reconciliationDifferenceMinor: z.number().int(),
  limitations: z.array(z.string()),
});

const agingBucketKeySchema = z.enum(["0-30", "31-60", "61-90", "91+"]);

const agingBucketsSchema = z.object({
  "0-30": z.number().int(),
  "31-60": z.number().int(),
  "61-90": z.number().int(),
  "91+": z.number().int(),
});

export const agingReportResponseSchema = z.object({
  reportKey: z.literal("aging"),
  side: z.enum(["ar", "ap"]),
  title: z.string(),
  labelMode: labelModeSchema,
  bookId: z.string(),
  currency: z.string(),
  asOf: z.string(),
  basis: z.enum(["due", "issue"]),
  bucketLabels: z.object({
    "0-30": z.string(),
    "31-60": z.string(),
    "61-90": z.string(),
    "91+": z.string(),
  }),
  parties: z.array(
    z.object({
      partyId: z.string(),
      partyName: z.string(),
      buckets: agingBucketsSchema,
      totalMinor: z.number().int(),
      documentCount: z.number().int(),
      oldestAgeDays: z.number().int(),
    }),
  ),
  totals: agingBucketsSchema,
  totalOpenMinor: z.number().int(),
  /** Null unless the caller asked for document detail. */
  documents: z
    .array(
      z.object({
        documentId: z.string(),
        documentNumber: z.string().nullable(),
        documentType: z.string(),
        partyId: z.string(),
        partyName: z.string(),
        issueDate: z.string(),
        dueDate: z.string().nullable(),
        basisDate: z.string(),
        ageDays: z.number().int(),
        bucket: agingBucketKeySchema,
        currency: z.string(),
        openMinor: z.number().int(),
        functionalOpenMinor: z.number().int(),
      }),
    )
    .nullable(),
  documentsTruncated: z.boolean(),
  controlAccountCode: z.string().nullable(),
  controlAccountBalanceMinor: z.number().int(),
  differenceMinor: z.number().int(),
  reconciles: z.boolean(),
  notes: z.array(z.string()),
});

const taxGlRoleSchema = z.enum(taxGlRoleEnum.enumValues);

const taxCurrencyTotalsSchema = z.object({
  currency: z.string(),
  taxableMinor: z.number().int(),
  taxMinor: z.number().int(),
  outputTaxMinor: z.number().int(),
  recoverableInputTaxMinor: z.number().int(),
  blockedInputTaxMinor: z.number().int(),
  withheldTaxMinor: z.number().int(),
  netPayableMinor: z.number().int(),
});

export const taxSummaryReportResponseSchema = z.object({
  reportKey: z.literal("tax_summary"),
  title: z.string(),
  labelMode: labelModeSchema,
  bookId: z.string(),
  currency: z.string(),
  from: z.string(),
  to: z.string(),
  rows: z.array(
    z.object({
      glRole: taxGlRoleSchema,
      glRoleLabel: z.string(),
      component: z.string(),
      jurisdiction: z.string(),
      rateBp: z.number().int(),
      currency: z.string(),
      taxableMinor: z.number().int(),
      taxMinor: z.number().int(),
      documentCount: z.number().int(),
    }),
  ),
  byRole: z.array(
    z.object({
      glRole: taxGlRoleSchema,
      label: z.string(),
      taxableMinor: z.number().int(),
      taxMinor: z.number().int(),
    }),
  ),
  byComponent: z.array(
    z.object({
      component: z.string(),
      taxableMinor: z.number().int(),
      taxMinor: z.number().int(),
    }),
  ),
  byCurrency: z.array(taxCurrencyTotalsSchema),
  totals: taxCurrencyTotalsSchema,
  notes: z.array(z.string()),
});
