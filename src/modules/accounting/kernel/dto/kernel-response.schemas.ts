import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";
import {
  glAccountTypeEnum,
  glBookStatusEnum,
  glFiscalYearStatusEnum,
  glJournalSourceEnum,
  glPeriodStatusEnum,
  glSystemTagEnum,
} from "../../../../db/schema";

/**
 * What the kernel's HTTP surface actually returns.
 *
 * The enums come from the drizzle declarations rather than from the request
 * schemas in `kernel.schemas.ts`: those lists are narrower than the database's
 * (`grni`, `expense_claim` and the two inventory variance roles are missing
 * from them), and a response schema that rejects a value the column can hold
 * would fail a real request under `NODE_ENV=test`.
 *
 * Money is integer minor units throughout — `z.number().int()`, never a
 * decimal string. The two exceptions are `rate`, a `numeric(18,10)` column that
 * postgres-js hands back as a string, and the display fields on the FX preview.
 */

const accountTypeSchema = z.enum(glAccountTypeEnum.enumValues);
const systemTagSchema = z.enum(glSystemTagEnum.enumValues);
const journalSourceSchema = z.enum(glJournalSourceEnum.enumValues);

/* ------------------------------------------------------------------ books */

/** `BooksService.toSummary` — a projection, not the row. */
const bookSummarySchema = z.object({
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
});

export const enableAccountingResponseSchema = bookSummarySchema;
export const getBookResponseSchema = bookSummarySchema;
export const listBooksResponseSchema = z.array(bookSummarySchema);

export const listPacksResponseSchema = z.array(
  z.object({
    code: z.string(),
    title: z.string(),
    status: z.enum(["enabled", "stub"]),
    countryCodes: z.array(z.string()),
    defaultCurrency: z.string(),
    fiscalYearStart: z.object({ month: z.number().int(), day: z.number().int() }),
    taxEngine: z.string(),
  }),
);

/* ------------------------------------------------------- chart of accounts */

/** The whole `gl_accounts` row — `create`, `update` and `setSystemTag` all `.returning()`. */
const accountRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  bookId: z.string(),
  code: z.string(),
  name: z.string(),
  accountType: accountTypeSchema,
  parentAccountId: z.string().nullable(),
  isHeader: z.boolean(),
  isActive: z.boolean(),
  isCash: z.boolean(),
  systemTag: systemTagSchema.nullable(),
  currencyRestriction: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const getAccountResponseSchema = accountRowSchema;
export const createAccountResponseSchema = accountRowSchema;
export const updateAccountResponseSchema = accountRowSchema;
export const setSystemTagResponseSchema = accountRowSchema;

/**
 * Archiving answers with the row plus why it went the way it did: an account
 * with postings is deactivated rather than soft-deleted, and the caller needs
 * to be able to say which happened.
 */
export const archiveAccountResponseSchema = accountRowSchema.extend({
  deactivatedInsteadOfDeleted: z.boolean(),
  postings: z.number().int(),
});

const accountNodeFieldsSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  accountType: accountTypeSchema,
  parentAccountId: z.string().nullable(),
  isHeader: z.boolean(),
  isActive: z.boolean(),
  isCash: z.boolean(),
  systemTag: systemTagSchema.nullable(),
  currencyRestriction: z.string().nullable(),
  description: z.string().nullable(),
});

/**
 * A finite tower rather than a `z.lazy`, matching the convention the rest of
 * the repo already settled on for recursive shapes. Four levels covers every
 * shipped chart; a deeper node still validates, because its own `children` is
 * simply an undeclared key and zod objects are non-strict.
 */
export const listAccountsResponseSchema = z.array(
  accountNodeFieldsSchema.extend({
    children: z.array(
      accountNodeFieldsSchema.extend({
        children: z.array(
          accountNodeFieldsSchema.extend({
            children: z.array(accountNodeFieldsSchema),
          }),
        ),
      }),
    ),
  }),
);

export const listPostableResponseSchema = z.array(
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    accountType: accountTypeSchema,
    isCash: z.boolean(),
    systemTag: systemTagSchema.nullable(),
    currencyRestriction: z.string().nullable(),
  }),
);

/** Every role, mapped or not — the unmapped ones are the point of the screen. */
export const listAccountMappingsResponseSchema = z.array(
  z.object({
    tag: systemTagSchema,
    allowedAccountTypes: z.array(accountTypeSchema),
    account: z
      .object({
        id: z.string(),
        code: z.string(),
        name: z.string(),
        accountType: accountTypeSchema,
      })
      .nullable(),
    requiredByInventory: z.boolean(),
    awaitingInventorySupport: z.boolean(),
  }),
);

/* ---------------------------------------------------------------- periods */

export const listFiscalYearsResponseSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    startsOn: z.string(),
    endsOn: z.string(),
    status: z.enum(glFiscalYearStatusEnum.enumValues),
  }),
);

/** `ensureFiscalYear` projects four columns whether it created the year or found it. */
export const openNextFiscalYearResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
});

export const listPeriodsResponseSchema = z.array(
  z.object({
    id: z.string(),
    fiscalYearId: z.string(),
    name: z.string(),
    startsOn: z.string(),
    endsOn: z.string(),
    sequence: z.number().int(),
    status: z.enum(glPeriodStatusEnum.enumValues),
    lockedAt: nullableWireDate(),
    lockReason: z.string().nullable(),
  }),
);

/** Lock and unlock both `.returning()` the whole `gl_periods` row. */
const periodRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  bookId: z.string(),
  fiscalYearId: z.string(),
  name: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  sequence: z.number().int(),
  status: z.enum(glPeriodStatusEnum.enumValues),
  lockedBy: z.string().nullable(),
  lockedAt: nullableWireDate(),
  lockReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const lockPeriodResponseSchema = periodRowSchema;
export const unlockPeriodResponseSchema = periodRowSchema;

/* --------------------------------------------------------------- journals */

const postedJournalLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  accountId: z.string(),
  accountCode: z.string(),
  accountName: z.string(),
  debitMinor: z.number().int(),
  creditMinor: z.number().int(),
  txnCurrency: z.string(),
  txnAmountMinor: z.number().int(),
  functionalCurrency: z.string(),
  functionalAmountMinor: z.number().int(),
  fxRate: z.string(),
  description: z.string().nullable(),
});

/** `PostedJournal` — what `post`, `reverse` and `loadJournal` all resolve to. */
export const postedJournalResponseSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  journalNumber: z.string(),
  journalDate: z.string(),
  periodId: z.string(),
  memo: z.string().nullable(),
  sourceType: journalSourceSchema,
  sourceId: z.string().nullable(),
  idempotencyKey: z.string(),
  reversesJournalId: z.string().nullable(),
  reversedByJournalId: z.string().nullable(),
  postedByUserId: z.string().nullable(),
  postedAt: wireDate(),
  totalDebitMinor: z.number().int(),
  totalCreditMinor: z.number().int(),
  functionalCurrency: z.string(),
  lines: z.array(postedJournalLineSchema),
  replayed: z.boolean(),
});

export const trialBalanceResponseSchema = z.object({
  asOf: z.string(),
  currency: z.string(),
  rows: z.array(
    z.object({
      accountId: z.string(),
      code: z.string(),
      name: z.string(),
      accountType: z.string(),
      debitMinor: z.number().int(),
      creditMinor: z.number().int(),
      balanceMinor: z.number().int(),
    }),
  ),
  totalDebitMinor: z.number().int(),
  totalCreditMinor: z.number().int(),
  balanced: z.boolean(),
});

const accountBalanceSchema = z.object({
  debitMinor: z.number().int(),
  creditMinor: z.number().int(),
  balanceMinor: z.number().int(),
});

export const accountLedgerResponseSchema = z.object({
  accountId: z.string(),
  code: z.string(),
  name: z.string(),
  accountType: accountTypeSchema,
  from: z.string(),
  to: z.string(),
  opening: accountBalanceSchema,
  periodDebitMinor: z.number().int(),
  periodCreditMinor: z.number().int(),
  closingBalanceMinor: z.number().int(),
  entries: z.array(
    z.object({
      lineId: z.string(),
      lineNo: z.number().int(),
      journalId: z.string(),
      journalNumber: z.string(),
      journalDate: z.string(),
      memo: z.string().nullable(),
      description: z.string().nullable(),
      debitMinor: z.number().int(),
      creditMinor: z.number().int(),
      runningBalanceMinor: z.number().int(),
      sourceType: journalSourceSchema,
      sourceId: z.string().nullable(),
    }),
  ),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  /** Added by the handler from the book, not by the page query. */
  currency: z.string(),
});

/* --------------------------------------------------------------------- FX */

export const listCurrenciesResponseSchema = z.array(
  z.object({
    code: z.string(),
    name: z.string(),
    minorUnits: z.number().int(),
    symbol: z.string().nullable(),
  }),
);

export const listBookCurrenciesResponseSchema = z.array(
  z.object({
    currencyCode: z.string(),
    isBase: z.boolean(),
    minorUnits: z.number().int(),
    name: z.string(),
    symbol: z.string().nullable(),
  }),
);

export const enableCurrencyResponseSchema = z.object({ currencyCode: z.string() });

export const listFxRatesResponseSchema = z.array(
  z.object({
    id: z.string(),
    fromCode: z.string(),
    toCode: z.string(),
    rateDate: z.string(),
    rate: z.string(),
    source: z.string(),
    capturedAt: wireDate(),
  }),
);

/** The upsert `.returning()`s the whole row, so it carries the tenant columns too. */
export const upsertFxRateResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  bookId: z.string(),
  fromCode: z.string(),
  toCode: z.string(),
  rateDate: z.string(),
  rate: z.string(),
  source: z.string(),
  capturedAt: wireDate(),
  createdBy: z.string().nullable(),
});

const fxPreviewSideSchema = z.object({
  currency: z.string(),
  amountMinor: z.number().int(),
  display: z.string(),
  minorUnits: z.number().int(),
});

export const previewFxResponseSchema = z.object({
  from: fxPreviewSideSchema,
  to: fxPreviewSideSchema,
  rate: z.string(),
  rateDate: z.string(),
  /** Empty for a same-currency rate, which the service normalizes to null. */
  rateId: z.string().nullable(),
});
