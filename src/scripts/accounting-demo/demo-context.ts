/**
 * Wiring for the accounting demo seed.
 *
 * The services are constructed by hand rather than through Nest DI: a script
 * has no request context, and booting `AppModule` to post a dozen documents
 * would cost more than the seed does. Everything below is the real service —
 * nothing here writes to `gl_journals` itself.
 */
import { and, eq } from "drizzle-orm";
import {
  apDocuments,
  apPayments,
  arDocuments,
  arReceipts,
  organizationMembers,
  orgModules,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { AccountingSetupService } from "../../modules/accounting/setup/accounting-setup.service";
import { OpeningBalancesService } from "../../modules/accounting/setup/opening-balances.service";
import { AccountsService } from "../../modules/accounting/kernel/accounts.service";
import { BooksService } from "../../modules/accounting/kernel/books.service";
import { FxService } from "../../modules/accounting/kernel/fx.service";
import { LedgerService } from "../../modules/accounting/kernel/ledger.service";
import { SequenceService } from "../../modules/accounting/kernel/sequence.service";
import { PackRegistry } from "../../modules/accounting/packs/pack.registry";
import { PartiesService } from "../../modules/accounting/parties/parties.service";
import { TaxEngineRegistry } from "../../modules/accounting/tax/tax-engine.registry";
import { TaxService } from "../../modules/accounting/tax/tax.service";
import { ComplianceService } from "../../modules/accounting/compliance/compliance.service";
import { ArDocumentsService } from "../../modules/accounting/ar/ar-documents.service";
import { ArReceiptsService } from "../../modules/accounting/ar/ar-receipts.service";
import { ApDocumentsService } from "../../modules/accounting/ap/ap-documents.service";
import { ApPaymentsService } from "../../modules/accounting/ap/ap-payments.service";
import { WithholdingEngineRegistry } from "../../modules/accounting/ap/withholding/withholding.registry";
import { BankAccountsService } from "../../modules/accounting/banking/bank-accounts.service";
import { StatementImportService } from "../../modules/accounting/banking/statement-import.service";
import { MatchingService } from "../../modules/accounting/banking/matching.service";
import { ReconciliationService } from "../../modules/accounting/banking/reconciliation.service";

export const BOOKS_OPEN_ON = "2026-04-01";
/** Opening balances are dated the day before the books open, so that day needs a period too. */
export const DAY_BEFORE_OPEN = "2026-03-31";
export const QUARTER_END = "2026-06-30";
export const KARNATAKA = "29";
export const MAHARASHTRA = "27";
export const USD_RATE = "83.50";

const SELLER_GSTIN = "29AABCU9603R1ZM";

/** Paise. 250,000.00 INR of founder cash. */
const OPENING_CASH = 25_000_000;

export const CODE = { bank: "1020", capital: "3100" } as const;

export type Services = ReturnType<typeof buildServices>;

export interface Context extends Services {
  db: Db;
  orgId: string;
  userId: string;
  bookId: string;
  baseCurrency: string;
}

export function buildServices(db: Db) {
  const packs = new PackRegistry();
  const audit = new AuditService(db);
  const sequences = new SequenceService(db);
  const books = new BooksService(db, packs);
  const ledger = new LedgerService(db, sequences, packs);
  const tax = new TaxService(db, new TaxEngineRegistry());
  const parties = new PartiesService(db, books);
  const accounts = new AccountsService(db, audit);
  const fx = new FxService(db, audit);
  const compliance = new ComplianceService(db);
  const bankAccounts = new BankAccountsService(db, books);
  const statements = new StatementImportService(db, bankAccounts);
  const matching = new MatchingService(db, bankAccounts);

  return {
    packs,
    books,
    ledger,
    accounts,
    fx,
    parties,
    setup: new AccountingSetupService(db, books, tax, packs, audit),
    opening: new OpeningBalancesService(db, books, ledger, audit),
    invoices: new ArDocumentsService(db, books, ledger, sequences, packs, tax, parties, compliance),
    receipts: new ArReceiptsService(db, books, ledger, sequences, packs, parties),
    bills: new ApDocumentsService(db, books, ledger, sequences, tax, packs),
    payments: new ApPaymentsService(
      db,
      books,
      ledger,
      sequences,
      tax,
      packs,
      new WithholdingEngineRegistry(),
    ),
    bankAccounts,
    statements,
    matching,
    reconciliation: new ReconciliationService(db, books, bankAccounts, statements, matching),
  };
}

export async function requireOwner(db: Db, orgId: string): Promise<string> {
  const [owner] = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.isOwner, true)))
    .limit(1);
  if (!owner) throw new Error(`Organization ${orgId} has no owner membership to attribute this to`);
  return owner.userId;
}

export async function accountIdFor(ctx: Context, code: string): Promise<string> {
  const postable = await ctx.accounts.listPostable(ctx.orgId, ctx.bookId);
  const account = postable.find((a) => a.code === code);
  if (!account) throw new Error(`The chart of accounts is missing ${code}`);
  return account.id;
}

type ReferencedTable = typeof arDocuments | typeof apDocuments | typeof arReceipts | typeof apPayments;

/**
 * The seed's idempotency hinge: every document carries a stable `reference`, so
 * a second run finds what the first one wrote instead of writing it again.
 */
export async function findByReference(
  ctx: Context,
  table: ReferencedTable,
  reference: string,
): Promise<{ id: string; status: string } | null> {
  const [row] = await ctx.db
    .select({ id: table.id, status: table.status })
    .from(table)
    .where(and(eq(table.orgId, ctx.orgId), eq(table.bookId, ctx.bookId), eq(table.reference, reference)))
    .limit(1);
  return row ?? null;
}

export function requireParty(parties: Map<string, string>, key: string): string {
  const id = parties.get(key);
  if (!id) throw new Error(`The demo party ${key} was not seeded`);
  return id;
}

export async function enableAccounting(
  db: Db,
  services: Services,
  orgId: string,
  userId: string,
): Promise<Context> {
  const book = await services.setup.enable(orgId, userId, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    openFrom: DAY_BEFORE_OPEN,
  });
  await services.books.ensureFiscalYear(orgId, book.bookId, BOOKS_OPEN_ON);

  const registrations = await services.setup.listTaxRegistrations(orgId);
  if (registrations.length === 0) {
    await services.setup.addTaxRegistration(orgId, userId, {
      regime: "GST_IN",
      number: SELLER_GSTIN,
      countryCode: "IN",
      isPrimary: true,
    });
  }

  await services.fx.enableCurrency(orgId, userId, book.bookId, "USD");
  await services.fx.upsertRate(orgId, userId, book.bookId, {
    fromCode: "USD",
    toCode: "INR",
    rateDate: BOOKS_OPEN_ON,
    rate: USD_RATE,
    source: "seed",
  });

  return { db, ...services, orgId, userId, bookId: book.bookId, baseCurrency: book.baseCurrency };
}

export async function postOpeningBalances(ctx: Context): Promise<void> {
  if (await ctx.opening.isPosted(ctx.orgId, ctx.bookId)) return;
  await ctx.opening.post(ctx.orgId, ctx.userId, {
    asOfDate: BOOKS_OPEN_ON,
    memo: "Demo opening position",
    lines: [
      { accountId: await accountIdFor(ctx, CODE.bank), amountMinor: OPENING_CASH },
      { accountId: await accountIdFor(ctx, CODE.capital), amountMinor: -OPENING_CASH },
    ],
  });
}

/**
 * Whether the org can actually reach the screens this seeds.
 *
 * The books are correct either way — `ModuleGuard` is a plan entitlement, not
 * an accounting fact — but a demo nobody can open is worth saying out loud.
 */
export async function isModuleEnabled(db: Db, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: orgModules.enabled })
    .from(orgModules)
    .where(and(eq(orgModules.orgId, orgId), eq(orgModules.moduleKey, "accounting")))
    .limit(1);
  return row?.enabled ?? false;
}
