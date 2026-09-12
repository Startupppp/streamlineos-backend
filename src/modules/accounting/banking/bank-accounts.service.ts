/**
 * Bank accounts (PRD 04 M1).
 *
 * **A bank account is a GL account.** `bank_profiles` carries the metadata a
 * bank needs — display name, currency, the identifier scheme, the CSV layout —
 * hung off an existing `gl_accounts` row with `is_cash` set. There is
 * deliberately no balance column anywhere in this module: the balance is
 * `sum(debits) - sum(credits)` over `gl_journal_lines`, which is the only
 * reason GL and bank can be reconciled at all. A cached balance would be a
 * second source of truth that silently drifts.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import {
  bankProfiles,
  glAccounts,
  glJournalLines,
  glJournals,
  type BankProfile,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import type { DbOrTx } from "../kernel/sequence.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { assertCurrencyCode, minorUnitsOf, MoneyError } from "../kernel/money";
import { assertMappingIsUsable, type LooseColumnMapping } from "./statement-csv";
import { findMappingPreset } from "./csv-presets";
import { isUniqueViolation } from "./pg-errors";

export type BankIdentifierScheme =
  | "IFSC_ACCOUNT"
  | "IBAN"
  | "ROUTING_ACCOUNT"
  | "SORT_ACCOUNT"
  | "BSB_ACCOUNT"
  | "UPI"
  | "OTHER";

export interface CreateBankAccountInput {
  /** Defaults to the org's default book. */
  bookId?: string;
  /** An existing GL account with `isCash`. Never created here. */
  accountId: string;
  displayName: string;
  bankName?: string;
  /** Defaults to the account's currency restriction, else the book's base. */
  currency?: string;
  countryCode?: string;
  identifierScheme?: BankIdentifierScheme;
  identifierValue?: string;
  branchIdentifier?: string;
  /** A named layout from `csv-presets.ts`, copied into `csvMapping`. */
  csvMappingPreset?: string;
  csvMapping?: LooseColumnMapping;
  isActive?: boolean;
}

export interface UpdateBankAccountInput {
  displayName?: string;
  bankName?: string | null;
  countryCode?: string;
  identifierScheme?: BankIdentifierScheme | null;
  identifierValue?: string | null;
  branchIdentifier?: string | null;
  isActive?: boolean;
}

export interface BankAccountSummary {
  id: string;
  bookId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  displayName: string;
  bankName: string | null;
  currency: string;
  countryCode: string;
  identifierScheme: BankIdentifierScheme | null;
  identifierValue: string | null;
  branchIdentifier: string | null;
  csvMapping: BankProfile["csvMapping"];
  isActive: boolean;
}

export interface BankAccountBalance {
  bankProfileId: string;
  accountId: string;
  asOf: string;
  /** Functional (book base) minor units — debits less credits. */
  functionalCurrency: string;
  functionalBalanceMinor: number;
  /** The same balance in the currency the bank reports in (PRD 04 M7). */
  currency: string;
  balanceMinor: number;
}

export interface PaginatedBankAccounts {
  items: BankAccountSummary[];
  page: number;
  pageSize: number;
  total: number;
}

@Injectable()
export class BankAccountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  /* --------------------------------------------------------------- create */

  async create(
    orgId: string,
    _userId: string | null,
    input: CreateBankAccountInput,
  ): Promise<BankAccountSummary> {
    const book = input.bookId
      ? await this.books.get(orgId, input.bookId)
      : await this.books.requireDefault(orgId);

    const account = await this.requireCashAccount(orgId, book.id, input.accountId);

    const currency = this.resolveCurrency(input.currency, account.currencyRestriction, book.baseCurrency);
    if (account.currencyRestriction && account.currencyRestriction !== currency) {
      throw new BadRequestException(
        `GL account ${account.code} only accepts ${account.currencyRestriction}, ` +
          `so its bank profile cannot report in ${currency}`,
      );
    }

    const csvMapping = this.resolveMappingForStorage(input.csvMappingPreset, input.csvMapping);

    try {
      const [row] = await this.db
        .insert(bankProfiles)
        .values({
          orgId,
          bookId: book.id,
          accountId: account.id,
          displayName: input.displayName.trim(),
          bankName: input.bankName?.trim() || null,
          currency,
          countryCode: (input.countryCode ?? book.countryCode).toUpperCase(),
          identifierScheme: input.identifierScheme ?? null,
          identifierValue: input.identifierValue?.trim() || null,
          branchIdentifier: input.branchIdentifier?.trim() || null,
          csvMapping,
          isActive: input.isActive ?? true,
        })
        .returning();
      if (!row) throw new ConflictException("Could not create the bank account");
      return this.toSummary(row, account.code, account.name);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `GL account ${account.code} already has a bank account attached. ` +
            "One GL account is one bank account, or none.",
        );
      }
      throw error;
    }
  }

  /* ----------------------------------------------------------- read paths */

  async get(orgId: string, bankProfileId: string, tx: DbOrTx = this.db): Promise<BankAccountSummary> {
    const [row] = await tx
      .select({
        profile: bankProfiles,
        accountCode: glAccounts.code,
        accountName: glAccounts.name,
      })
      .from(bankProfiles)
      .innerJoin(glAccounts, eq(bankProfiles.accountId, glAccounts.id))
      .where(and(eq(bankProfiles.orgId, orgId), eq(bankProfiles.id, bankProfileId)))
      .limit(1);

    // A profile in another tenant is "not found", never "forbidden".
    if (!row) throw new NotFoundException("Bank account not found");
    return this.toSummary(row.profile, row.accountCode, row.accountName);
  }

  async list(
    orgId: string,
    query: { bookId?: string; includeInactive?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<PaginatedBankAccounts> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));

    const conditions = [eq(bankProfiles.orgId, orgId)];
    if (query.bookId) conditions.push(eq(bankProfiles.bookId, query.bookId));
    if (!query.includeInactive) conditions.push(eq(bankProfiles.isActive, true));
    const where = and(...conditions);

    const rows = await this.db
      .select({
        profile: bankProfiles,
        accountCode: glAccounts.code,
        accountName: glAccounts.name,
        total: sql<number>`count(*) over ()`,
      })
      .from(bankProfiles)
      .innerJoin(glAccounts, eq(bankProfiles.accountId, glAccounts.id))
      .where(where)
      .orderBy(asc(bankProfiles.displayName))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((r) => this.toSummary(r.profile, r.accountCode, r.accountName)),
      page,
      pageSize,
      total: rows.length > 0 ? Number(rows[0].total) : 0,
    };
  }

  /* --------------------------------------------------------------- update */

  async update(
    orgId: string,
    _userId: string | null,
    bankProfileId: string,
    patch: UpdateBankAccountInput,
  ): Promise<BankAccountSummary> {
    await this.get(orgId, bankProfileId);

    const values: Partial<typeof bankProfiles.$inferInsert> = {};
    if (patch.displayName !== undefined) values.displayName = patch.displayName.trim();
    if (patch.bankName !== undefined) values.bankName = patch.bankName?.trim() || null;
    if (patch.countryCode !== undefined) values.countryCode = patch.countryCode.toUpperCase();
    if (patch.identifierScheme !== undefined) values.identifierScheme = patch.identifierScheme;
    if (patch.identifierValue !== undefined) values.identifierValue = patch.identifierValue?.trim() || null;
    if (patch.branchIdentifier !== undefined)
      values.branchIdentifier = patch.branchIdentifier?.trim() || null;
    if (patch.isActive !== undefined) values.isActive = patch.isActive;

    // The currency and the GL account are not patchable: both are frozen into
    // every statement and match already recorded against this profile.
    if (Object.keys(values).length > 0) {
      await this.db
        .update(bankProfiles)
        .set(values)
        .where(and(eq(bankProfiles.orgId, orgId), eq(bankProfiles.id, bankProfileId)));
    }

    return this.get(orgId, bankProfileId);
  }

  /** Save (or replace) the per-account CSV layout. */
  async saveCsvMapping(
    orgId: string,
    bankProfileId: string,
    input: { preset?: string; mapping?: LooseColumnMapping },
  ): Promise<BankAccountSummary> {
    await this.get(orgId, bankProfileId);
    const csvMapping = this.resolveMappingForStorage(input.preset, input.mapping);
    if (!csvMapping) {
      throw new BadRequestException("Provide a mapping preset or an explicit column mapping");
    }

    await this.db
      .update(bankProfiles)
      .set({ csvMapping })
      .where(and(eq(bankProfiles.orgId, orgId), eq(bankProfiles.id, bankProfileId)));

    return this.get(orgId, bankProfileId);
  }

  /* -------------------------------------------------------------- balance */

  /**
   * The cash balance, derived. Debits less credits on the account, over every
   * journal dated on or before `asOf`.
   *
   * Pass `currency` to read the balance in the **transaction** currency instead
   * of the functional one — a USD account on INR books reconciles in USD, and
   * the txn amounts are what the bank statement can be compared against.
   */
  async glBalanceMinor(
    bookId: string,
    accountId: string,
    asOf: string,
    options: { currency?: string; tx?: DbOrTx } = {},
  ): Promise<number> {
    const tx = options.tx ?? this.db;
    const on = assertIsoDate(asOf);

    const amount = options.currency
      ? sql<number>`coalesce(sum(case when ${glJournalLines.debitMinor} > 0
            then ${glJournalLines.txnAmountMinor} else -${glJournalLines.txnAmountMinor} end), 0)::bigint`
      : sql<number>`coalesce(sum(${glJournalLines.debitMinor} - ${glJournalLines.creditMinor}), 0)::bigint`;

    const conditions = [
      eq(glJournalLines.bookId, bookId),
      eq(glJournalLines.accountId, accountId),
      lte(glJournals.journalDate, on),
    ];
    if (options.currency) {
      conditions.push(eq(glJournalLines.txnCurrency, assertCurrencyCode(options.currency)));
    }

    const [row] = await tx
      .select({ amount })
      .from(glJournalLines)
      .innerJoin(glJournals, eq(glJournalLines.journalId, glJournals.id))
      .where(and(...conditions));

    return Number(row?.amount ?? 0);
  }

  /** Both readings of the same balance, for a UI that shows either. */
  async balance(orgId: string, bankProfileId: string, asOf: string): Promise<BankAccountBalance> {
    const profile = await this.get(orgId, bankProfileId);
    const book = await this.books.get(orgId, profile.bookId);

    const functionalBalanceMinor = await this.glBalanceMinor(profile.bookId, profile.accountId, asOf);
    const balanceMinor =
      profile.currency === book.baseCurrency
        ? functionalBalanceMinor
        : await this.glBalanceMinor(profile.bookId, profile.accountId, asOf, {
            currency: profile.currency,
          });

    return {
      bankProfileId: profile.id,
      accountId: profile.accountId,
      asOf: assertIsoDate(asOf),
      functionalCurrency: book.baseCurrency,
      functionalBalanceMinor,
      currency: profile.currency,
      balanceMinor,
    };
  }

  /* ------------------------------------------------------------- internals */

  /**
   * The account a profile may attach to: in this book, alive, active, a posting
   * account, and flagged as cash. Anything else is a setup mistake worth naming.
   */
  private async requireCashAccount(orgId: string, bookId: string, accountId: string) {
    const [account] = await this.db
      .select({
        id: glAccounts.id,
        code: glAccounts.code,
        name: glAccounts.name,
        isCash: glAccounts.isCash,
        isHeader: glAccounts.isHeader,
        isActive: glAccounts.isActive,
        accountType: glAccounts.accountType,
        currencyRestriction: glAccounts.currencyRestriction,
      })
      .from(glAccounts)
      .where(
        and(
          eq(glAccounts.orgId, orgId),
          eq(glAccounts.bookId, bookId),
          eq(glAccounts.id, accountId),
          isNull(glAccounts.deletedAt),
        ),
      )
      .limit(1);

    if (!account) throw new NotFoundException("GL account not found in this book");

    if (account.isHeader) {
      throw new BadRequestException(
        `${account.code} ${account.name} is a header account. Headers group other accounts and ` +
          "never receive a posting, so they cannot be a bank account.",
      );
    }
    if (!account.isCash) {
      throw new BadRequestException(
        `${account.code} ${account.name} is not a cash account. A bank account is a GL account ` +
          "with `is_cash` set — flag the account first, or pick the right one.",
      );
    }
    if (!account.isActive) {
      throw new BadRequestException(`${account.code} ${account.name} is inactive`);
    }

    return account;
  }

  private resolveCurrency(
    requested: string | undefined,
    restriction: string | null,
    baseCurrency: string,
  ): string {
    const currency = requested ?? restriction ?? baseCurrency;
    try {
      assertCurrencyCode(currency);
      minorUnitsOf(currency);
    } catch (error) {
      if (error instanceof MoneyError) throw new BadRequestException(error.message);
      throw error;
    }
    return currency;
  }

  /**
   * A preset is a starting point copied into the profile, so a later edit to
   * the preset never silently changes how an account's files are read.
   */
  private resolveMappingForStorage(
    presetCode: string | undefined,
    explicit: LooseColumnMapping | undefined,
  ): BankProfile["csvMapping"] {
    if (!presetCode && !explicit) return null;

    let base: LooseColumnMapping = {};
    if (presetCode) {
      const preset = findMappingPreset(presetCode);
      if (!preset) throw new BadRequestException(`Unknown CSV mapping preset ${JSON.stringify(presetCode)}`);
      base = preset.mapping;
    }

    const merged = { ...base, ...(explicit ?? {}) };
    try {
      const usable = assertMappingIsUsable(merged);
      // Only the columns `bank_profiles.csv_mapping` declares are persisted.
      return {
        dateColumn: usable.dateColumn,
        descriptionColumn: usable.descriptionColumn,
        referenceColumn: usable.referenceColumn,
        amountColumn: usable.amountColumn,
        debitColumn: usable.debitColumn,
        creditColumn: usable.creditColumn,
        dateFormat: usable.dateFormat,
        skipRows: usable.skipRows,
      };
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private toSummary(row: BankProfile, accountCode: string, accountName: string): BankAccountSummary {
    return {
      id: row.id,
      bookId: row.bookId,
      accountId: row.accountId,
      accountCode,
      accountName,
      displayName: row.displayName,
      bankName: row.bankName,
      currency: row.currency,
      countryCode: row.countryCode,
      identifierScheme: row.identifierScheme,
      identifierValue: row.identifierValue,
      branchIdentifier: row.branchIdentifier,
      csvMapping: row.csvMapping,
      isActive: row.isActive,
    };
  }
}
