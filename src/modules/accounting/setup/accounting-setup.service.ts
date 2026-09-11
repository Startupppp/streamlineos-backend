import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  glAccounts,
  glCurrencies,
  taxRegistrations,
  type GlSystemTag,
  type TaxRegime,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { BooksService, type EnableAccountingInput } from "../kernel/books.service";
import { TaxService } from "../tax/tax.service";
import { PackRegistry } from "../packs/pack.registry";
import { PeriodsService } from "../kernel/periods.service";
import { INVENTORY_SEAM_ROLES } from "../kernel/system-tag-roles";

export { INVENTORY_SEAM_ROLES };

/**
 * Whether this organisation's accounting is actually able to receive a posting.
 *
 * Three states, and the middle one is the whole point of ACC-02: an org can
 * have the accounting module switched on — paying for it, seeing its
 * navigation — and have no book at all. In that state every inventory post
 * raises `BOOK_NOT_ENABLED`, the bridge swallows it at `debug` exactly as it is
 * required to, and the org produces no journals for as long as nobody notices.
 * `BOOK_NOT_ENABLED` is indistinguishable from the honest opt-out at the point
 * where it is caught. It is only distinguishable here.
 */
export type AccountingProvisioning =
  | { state: "not_requested" }
  | { state: "unprovisioned"; message: string }
  | { state: "incomplete"; bookId: string; missingRoles: GlSystemTag[]; message: string }
  | {
      state: "fiscal_year_ending";
      bookId: string;
      endsOn: string;
      daysRemaining: number;
      message: string;
    }
  | { state: "ready"; bookId: string };

/**
 * How long before a fiscal year ends the product starts saying so.
 *
 * Thirty days is chosen against what the warning costs to act on, not against
 * how urgent it feels: opening the next year is one click, and the person who
 * has to click it is a finance lead who does not read the settings page daily.
 * A week would routinely land inside somebody's holiday; a quarter would be
 * background noise for two months and ignored by the time it mattered.
 */
const FISCAL_YEAR_WARNING_DAYS = 30;

export interface EnableAccountingResult {
  bookId: string;
  name: string;
  countryCode: string;
  baseCurrency: string;
  localizationPack: string;
  packStatus: "enabled" | "stub";
  fiscalYear: { id: string; name: string; startsOn: string; endsOn: string };
  accountsSeeded: number;
  taxCodesSeeded: number;
  /** What still needs doing before the first invoice can be raised. */
  nextSteps: string[];
}

/**
 * Enabling accounting, end to end.
 *
 * `BooksService` owns the ledger side and `TaxService` owns the tax side; this
 * orchestrates both so a founder gets a book, a chart, a fiscal year and a rate
 * table from one action. It lives above both to keep the kernel free of any
 * dependency on tax — the kernel must stay testable without it.
 *
 * Idempotent: running it twice returns the same book, unchanged.
 */
@Injectable()
export class AccountingSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly tax: TaxService,
    private readonly packs: PackRegistry,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly periods: PeriodsService,
  ) {}

  async enable(
    orgId: string,
    userId: string,
    input: EnableAccountingInput,
  ): Promise<EnableAccountingResult> {
    await this.assertReferenceDataInstalled(input.baseCurrency);

    const alreadyEnabled = await this.books.findDefault(orgId);
    const book = await this.books.enable(orgId, userId, input);
    const pack = this.packs.get(book.localizationPack);

    await this.tax.seedPack(orgId, book.id, pack.taxEngine);

    const fiscalYear = await this.books.ensureFiscalYear(
      orgId,
      book.id,
      input.openFrom ?? new Date().toISOString().slice(0, 10),
    );

    const counts = await this.counts(book.id);

    if (!alreadyEnabled) {
      this.audit.log({
        action: "accounting.enabled",
        userId,
        orgId,
        resourceType: "gl_books",
        resourceId: book.id,
        after: {
          countryCode: book.countryCode,
          baseCurrency: book.baseCurrency,
          localizationPack: book.localizationPack,
        },
      });
    }

    return {
      bookId: book.id,
      name: book.name,
      countryCode: book.countryCode,
      baseCurrency: book.baseCurrency,
      localizationPack: book.localizationPack,
      packStatus: pack.status,
      fiscalYear,
      accountsSeeded: counts.accounts,
      taxCodesSeeded: counts.taxCodes,
      nextSteps: await this.nextSteps(book.id, pack.status, pack.code),
    };
  }

  /**
   * ACC-02's actual failure mode: enabled, and unprovisioned in a way nothing said.
   *
   * `gl_book_currencies.currency_code` has an FK to `gl_currencies(code)`, and
   * `BooksService.enable` inserts the base-currency row with
   * `onConflictDoNothing()` -- which suppresses a UNIQUE conflict and cannot
   * suppress an FK violation. So on a database where `gl_currencies` is empty,
   * every attempt to switch accounting on for any organisation dies with a raw
   * 23503 out of the driver, and the operator is told nothing they can act on.
   *
   * **The empty table is not hypothetical and not test-only.** `0464a_gl_kernel`
   * carries both the DDL and this seed. `0489_chain_creates_early` and
   * `0619_chain_creates_what_production_has` transcribe a `pg_catalog`, so they
   * recreate the STRUCTURE and cannot recreate the DATA. Measured on the shared
   * branch: `gl_currencies` exists with the right columns and holds ZERO rows,
   * and `gl_accounts` is empty beside it. A correctly-shaped empty table is the
   * hardest kind of missing to notice.
   *
   * A cheap read on a tiny reference table, once per enablement, in exchange for
   * an error an operator can act on -- and it names the migration to run rather
   * than the constraint that fired.
   */
  private async assertReferenceDataInstalled(baseCurrency: string | undefined): Promise<void> {
    /*
      Emptiness first, and separately, because it is the failure that was actually
      measured and the only one an operator cannot diagnose. A caller who omits
      `baseCurrency` gets the pack's default, resolved inside `BooksService`; this
      does not duplicate that resolution, so an unknown code is only checked when
      the caller named one.
    */
    const [installed] = await this.db.select({ code: glCurrencies.code }).from(glCurrencies).limit(1);
    if (!installed) {
      throw new ConflictException(
        "Accounting reference data is not installed on this database: gl_currencies is empty, " +
          "so no book can name a base currency. Apply migration 0464a_gl_kernel, which carries the " +
          "currency seed as well as the schema.",
      );
    }

    if (baseCurrency === undefined) return;
    const [currency] = await this.db
      .select({ code: glCurrencies.code })
      .from(glCurrencies)
      .where(eq(glCurrencies.code, baseCurrency))
      .limit(1);
    if (!currency)
      throw new ConflictException(
        `${baseCurrency} is not one of the currencies this deployment knows about.`,
      );
  }

  /**
   * Register the book's own tax identity — the GSTIN or VAT number that
   * determination needs before a single invoice can be raised.
   */
  async addTaxRegistration(
    orgId: string,
    userId: string,
    input: {
      regime: TaxRegime;
      number: string;
      region?: string | null;
      countryCode: string;
      isPrimary?: boolean;
    },
  ) {
    const book = await this.books.requireDefault(orgId);
    const number = input.number.trim().toUpperCase();

    // India's state code is the first two digits of the GSTIN. Deriving it here
    // means the founder types one thing and place-of-supply still works.
    const region =
      input.region ?? (input.regime === "GST_IN" && /^\d{2}/.test(number) ? number.slice(0, 2) : null);

    const [row] = await this.db
      .insert(taxRegistrations)
      .values({
        orgId,
        ownerType: "book",
        bookId: book.id,
        regime: input.regime,
        number,
        region,
        countryCode: input.countryCode.toUpperCase(),
        isPrimary: input.isPrimary ?? true,
      })
      .returning();

    this.audit.log({
      action: "accounting.tax_registration.added",
      userId,
      orgId,
      resourceType: "tax_registrations",
      resourceId: row.id,
      after: { regime: input.regime, number, region },
    });
    return row;
  }

  async listTaxRegistrations(orgId: string) {
    const book = await this.books.requireDefault(orgId);
    return this.db
      .select({
        id: taxRegistrations.id,
        regime: taxRegistrations.regime,
        number: taxRegistrations.number,
        region: taxRegistrations.region,
        countryCode: taxRegistrations.countryCode,
        isPrimary: taxRegistrations.isPrimary,
      })
      .from(taxRegistrations)
      .where(
        and(eq(taxRegistrations.bookId, book.id), eq(taxRegistrations.ownerType, "book")),
      );
  }

  /**
   * Is this organisation's accounting able to accept a posting, and if not, why.
   *
   * Deliberately read-only and deliberately not on the inventory hot path. The
   * tempting shape — have the bridge refuse a goods receipt whenever the module
   * is on and the book is missing — would mean an org that switched accounting
   * on this morning could not receive goods this afternoon, which trades a
   * quiet reporting gap for a loud operational outage. `docs/inventory-gl-contract.md`
   * §4 fails closed on a book that *exists* and refuses; a book that was never
   * created is a setup task, and the answer to a setup task is to say so.
   */
  async provisioning(orgId: string): Promise<AccountingProvisioning> {
    const book = await this.books.findDefault(orgId);

    if (!book) {
      /*
        Only ask about the module when there is no book. An org with a book has
        settled the question by creating one, and this saves an entitlement
        round trip on the common path.
      */
      const requested = await this.access.isModuleEnabled(orgId, "accounting");
      if (!requested) return { state: "not_requested" };
      return {
        state: "unprovisioned",
        message:
          "The accounting module is enabled for this organisation but no book of accounts exists, " +
          "so nothing can post to the ledger: every stock movement, invoice and payroll run is " +
          "being accepted and recorded nowhere. Run accounting setup to create the book.",
      };
    }

    const cliff = await this.fiscalYearCliff(orgId, book.id);
    if (cliff) return cliff;

    const missingRoles = await this.missingSeamRoles(book.id);
    if (missingRoles.length > 0) {
      return {
        state: "incomplete",
        bookId: book.id,
        missingRoles,
        message:
          `This book has no account tagged ${missingRoles.map((r) => `"${r}"`).join(", ")}. ` +
          "Inventory resolves accounts by role, so the first movement needing one of these is " +
          "refused outright — the goods receipt or shipment does not happen. Re-run the chart " +
          "of accounts setup.",
      };
    }

    return { state: "ready", bookId: book.id };
  }

  /**
   * The same verdict, as a refusal. For callers that must not proceed on an
   * organisation whose accounting cannot receive what they are about to send.
   */
  async requireProvisioned(orgId: string): Promise<void> {
    const verdict = await this.provisioning(orgId);
    if (verdict.state === "unprovisioned" || verdict.state === "incomplete") {
      throw new ConflictException(verdict.message);
    }
  }

  /**
   * The last fiscal year is about to end and no later one is open.
   *
   * The kernel's `resolvePeriod` (kernel/lib/posting-preconditions.ts) refuses a journal whose date no period covers
   * — "No accounting period covers {date}. Open the fiscal year first." — and
   * nothing opens the next year on a schedule. So on the first day of a new
   * fiscal year (1 April, for the India pack) every posting on an organisation
   * whose next year was never opened is refused: invoices, goods receipts,
   * shipments, payroll runs.
   *
   * It is worse than a clean outage, because **it is not uniform**. AP calls
   * `ensureFiscalYear` before it posts (`ap-documents.service.ts`,
   * `ap-payments.service.ts`), so a supplier bill quietly opens the new year
   * and succeeds. AR does not, and neither does the inventory bridge — measured,
   * zero `ensureFiscalYear` calls in either. So the cost side of the ledger
   * keeps working while the revenue side stops, which makes accounting look
   * healthy at exactly the moment it is refusing every invoice.
   *
   * This warns rather than fixing it, deliberately. Opening a fiscal year
   * creates a year and twelve periods and is a decision with accounting
   * meaning; a seam pack should not make it silently on someone's behalf, and
   * the honest reading of the asymmetry above is that AP is too eager rather
   * than AR too strict. Turning a dated annual cliff into a warning a month out
   * is the part that is unambiguously this pack's to do.
   */
  private async fiscalYearCliff(
    orgId: string,
    bookId: string,
  ): Promise<AccountingProvisioning | null> {
    const years = await this.periods.listFiscalYears(orgId, bookId);
    if (years.length === 0) return null;

    /*
      The latest END, not the latest start. A pack whose years are opened out of
      order — a backdated prior year opened after the current one — would
      otherwise report the wrong cliff, and the question being asked is "how far
      forward can this book post", which only the furthest end answers.
    */
    const furthest = years.reduce((a, b) => (a.endsOn >= b.endsOn ? a : b));
    const daysRemaining = daysBetween(this.today(), furthest.endsOn);

    if (daysRemaining > FISCAL_YEAR_WARNING_DAYS) return null;

    return {
      state: "fiscal_year_ending",
      bookId,
      endsOn: furthest.endsOn,
      daysRemaining,
      message:
        `The last open fiscal year ends on ${furthest.endsOn}` +
        (daysRemaining >= 0 ? `, in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}` : "") +
        ". Nothing opens the next one automatically, and from the day after that date every " +
        "invoice, goods receipt, shipment and payroll run will be refused because no accounting " +
        "period covers the date. Open the next fiscal year.",
    };
  }

  /** Today, as an ISO date. Extracted so a test can pin it. */
  protected today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Which of the roles the inventory bridge names are not tagged in this book. */
  private async missingSeamRoles(bookId: string): Promise<GlSystemTag[]> {
    const rows = await this.db
      .select({ systemTag: glAccounts.systemTag })
      .from(glAccounts)
      .where(
        and(
          eq(glAccounts.bookId, bookId),
          eq(glAccounts.isActive, true),
          isNull(glAccounts.deletedAt),
        ),
      );
    const tagged = new Set(rows.map((r) => r.systemTag).filter(Boolean));
    return INVENTORY_SEAM_ROLES.filter((role) => !tagged.has(role));
  }

  /** Where setup stands — drives the onboarding checklist. */
  async status(orgId: string) {
    const book = await this.books.findDefault(orgId);
    if (!book) {
      /*
        Additive: `enabled: false` still means what it always did. What it never
        carried was the difference between "this org does not use accounting"
        and "this org is paying for accounting and posting into a void", which
        rendered identically as an empty settings page.
      */
      return { enabled: false as const, provisioning: await this.provisioning(orgId) };
    }

    const pack = this.packs.get(book.localizationPack);
    const counts = await this.counts(book.id);
    return {
      enabled: true as const,
      book,
      packStatus: pack.status,
      accounts: counts.accounts,
      taxCodes: counts.taxCodes,
      taxRegistrations: counts.registrations,
      provisioning: await this.provisioning(orgId),
      nextSteps: await this.nextSteps(book.id, pack.status, pack.code),
    };
  }

  private async counts(bookId: string) {
    // One round trip rather than three; this runs on every settings page load.
    // Parameterized via the `sql` template — never string-interpolated.
    const rows = await this.db.execute(sql`
      SELECT
        (SELECT count(*) FROM gl_accounts WHERE book_id = ${bookId} AND deleted_at IS NULL) AS accounts,
        (SELECT count(*) FROM tax_codes WHERE book_id = ${bookId}) AS tax_codes,
        (SELECT count(*) FROM tax_registrations WHERE book_id = ${bookId}) AS registrations
    `);
    const row = (rows as unknown as Array<Record<string, string>>)[0] ?? {};
    return {
      accounts: Number(row.accounts ?? 0),
      taxCodes: Number(row.tax_codes ?? 0),
      registrations: Number(row.registrations ?? 0),
    };
  }

  private async nextSteps(
    bookId: string,
    packStatus: "enabled" | "stub",
    packCode: string,
  ): Promise<string[]> {
    const steps: string[] = [];
    const counts = await this.counts(bookId);

    if (counts.registrations === 0) {
      steps.push("Add your tax registration number so invoices can be tax-correct");
    }
    if (packStatus === "stub") {
      steps.push(
        `Tax determination for ${packCode} is not implemented yet — switch to the generic VAT pack or enter tax manually`,
      );
    }
    steps.push("Record opening balances as at your start date");
    steps.push("Add a bank account and import your first statement");
    return steps;
  }
}

/**
 * Whole days from one ISO date to another, negative once the later one is past.
 *
 * Both are plain dates with no time and no zone, so this subtracts UTC
 * midnights rather than going through the host's timezone — a fiscal year ends
 * on a date, not at an instant, and reading it through a local clock would move
 * the boundary by a day for half the world.
 */
function daysBetween(from: string, to: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}
