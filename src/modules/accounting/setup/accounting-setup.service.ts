import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { taxRegistrations, type TaxRegime } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { BooksService, type EnableAccountingInput } from "../kernel/books.service";
import { TaxService } from "../tax/tax.service";
import { PackRegistry } from "../packs/pack.registry";

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
  ) {}

  async enable(
    orgId: string,
    userId: string,
    input: EnableAccountingInput,
  ): Promise<EnableAccountingResult> {
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

  /** Where setup stands — drives the onboarding checklist. */
  async status(orgId: string) {
    const book = await this.books.findDefault(orgId);
    if (!book) return { enabled: false as const };

    const pack = this.packs.get(book.localizationPack);
    const counts = await this.counts(book.id);
    return {
      enabled: true as const,
      book,
      packStatus: pack.status,
      accounts: counts.accounts,
      taxCodes: counts.taxCodes,
      taxRegistrations: counts.registrations,
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
