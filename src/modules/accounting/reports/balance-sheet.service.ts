import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { GlAccountType } from "../../../db/schema";
import { BooksService } from "../kernel/books.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { csvMoney, toCsv, withCsvPreamble } from "./report-csv";
import { label, type LabelMode } from "./report-labels";
import {
  classOf,
  classSigned,
  fiscalYearWindowFor,
  profitOf,
  readAccountMovementsWithZeros,
  resolveReportBook,
  type AccountClass,
  type AccountMovement,
  type FiscalYearWindow,
} from "./report-queries";

export interface BalanceSheetQuery {
  asOf: string;
  bookId?: string;
  includeZeroActivity?: boolean;
  labelMode?: LabelMode;
}

/** Computed equity lines are not accounts, so they are tagged instead. */
export type BalanceSheetComputedTag = "current_year_earnings" | "prior_year_earnings";

export interface BalanceSheetLine {
  /** Null on a computed line — there is no account behind it, by design. */
  accountId: string | null;
  code: string | null;
  name: string;
  accountType: GlAccountType | null;
  computed: boolean;
  tag: BalanceSheetComputedTag | null;
  /**
   * Signed in the section's own direction, so a contra account carries a
   * negative and visibly reduces its class rather than inflating the other
   * side of the sheet.
   */
  amountMinor: number;
  isContra: boolean;
}

export interface BalanceSheetSection {
  key: "assets" | "liabilities" | "equity";
  label: string;
  lines: BalanceSheetLine[];
  totalMinor: number;
}

export interface BalanceSheetReport {
  reportKey: "balance_sheet";
  title: string;
  labelMode: LabelMode;
  bookId: string;
  currency: string;
  asOf: string;
  fiscalYear: FiscalYearWindow;
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  totalEquityMinor: number;
  liabilitiesAndEquityMinor: number;
  /** Fiscal-year-to-date profit, computed here and never posted anywhere. */
  currentYearEarningsMinor: number;
  /** Everything earned before this fiscal year that no close has moved yet. */
  priorYearEarningsMinor: number;
  balanced: boolean;
  differenceMinor: number;
  notes: string[];
}

/**
 * Balance sheet as of a date.
 *
 * The load-bearing decision: **current-year earnings is a computed line, not a
 * posted balance.** A year-end close that journals profit into retained
 * earnings is a thing this product does not do yet, and faking it with a
 * posting would put a number in the ledger that the P&L could contradict. So
 * the sheet derives it:
 *
 *   assets = liabilities + posted equity + prior-year earnings + current-year earnings
 *
 * That identity is not a hope. Over a whole book, `sum(debit) = sum(credit)`,
 * which rearranges to exactly the line above once income and expense are split
 * at the fiscal-year boundary — so if `balanced` is ever false, the ledger is
 * broken or this file is, and either way nobody should trust the number.
 *
 * `prior_year_earnings` exists for the same reason: without it, a book in its
 * second year would be out by last year's profit and the sheet would silently
 * stop balancing.
 */
@Injectable()
export class BalanceSheetService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  async run(orgId: string, query: BalanceSheetQuery): Promise<BalanceSheetReport> {
    const asOf = assertIsoDate(query.asOf);
    const mode: LabelMode = query.labelMode ?? "founder";
    const includeZeroActivity = query.includeZeroActivity ?? false;
    const book = await resolveReportBook(this.books, orgId, query.bookId);
    const fiscalYear = await fiscalYearWindowFor(this.db, book, asOf);

    const asOfMovements = await readAccountMovementsWithZeros(
      this.db,
      { orgId, bookId: book.id, to: asOf },
      includeZeroActivity,
    );
    const yearToDate = await readAccountMovementsWithZeros(
      this.db,
      { orgId, bookId: book.id, from: fiscalYear.startsOn, to: asOf },
      false,
    );

    // Lifetime profit minus this year's profit is, by definition, everything
    // earned in earlier years — one query fewer than reading the prior span.
    const currentYearEarningsMinor = profitOf(yearToDate);
    const priorYearEarningsMinor = profitOf(asOfMovements) - currentYearEarningsMinor;

    const assets = this.section("assets", "ASSET", "section.assets", asOfMovements, mode);
    const liabilities = this.section(
      "liabilities",
      "LIABILITY",
      "section.liabilities",
      asOfMovements,
      mode,
    );
    const equity = this.section("equity", "EQUITY", "section.equity", asOfMovements, mode);

    if (priorYearEarningsMinor !== 0 || includeZeroActivity) {
      equity.lines.push({
        accountId: null,
        code: null,
        name: label("line.prior_year_earnings", mode),
        accountType: null,
        computed: true,
        tag: "prior_year_earnings",
        amountMinor: priorYearEarningsMinor,
        isContra: false,
      });
      equity.totalMinor += priorYearEarningsMinor;
    }

    // Always shown, even at zero: "how are we doing this year" is the question
    // the sheet is opened for.
    equity.lines.push({
      accountId: null,
      code: null,
      name: label("line.current_year_earnings", mode),
      accountType: null,
      computed: true,
      tag: "current_year_earnings",
      amountMinor: currentYearEarningsMinor,
      isContra: false,
    });
    equity.totalMinor += currentYearEarningsMinor;

    const liabilitiesAndEquityMinor = liabilities.totalMinor + equity.totalMinor;
    const differenceMinor = assets.totalMinor - liabilitiesAndEquityMinor;

    const notes: string[] = [
      "Current year earnings is computed from the ledger for this fiscal year to date. " +
        "It is never posted, so it cannot disagree with the profit and loss.",
    ];
    if (priorYearEarningsMinor !== 0) {
      notes.push(
        "Earlier years' profit is shown separately because no year-end close has journalled it " +
          "into retained earnings.",
      );
    }
    if (!fiscalYear.opened) {
      notes.push(
        `No fiscal year has been opened around ${asOf}; ${fiscalYear.name} was derived from the ` +
          "book's calendar.",
      );
    }
    const postedEarnings = asOfMovements.find(
      (m) => m.systemTag === "current_year_earnings" && m.debitMinor + m.creditMinor > 0,
    );
    if (postedEarnings) {
      notes.push(
        `Account ${postedEarnings.code} is tagged current_year_earnings but has postings against ` +
          "it. It is shown as posted equity in addition to the computed line; the sheet still " +
          "balances, but that account should not be posted to.",
      );
    }

    return {
      reportKey: "balance_sheet",
      title: label("report.balance_sheet", mode),
      labelMode: mode,
      bookId: book.id,
      currency: book.baseCurrency,
      asOf,
      fiscalYear,
      assets,
      liabilities,
      equity,
      totalAssetsMinor: assets.totalMinor,
      totalLiabilitiesMinor: liabilities.totalMinor,
      totalEquityMinor: equity.totalMinor,
      liabilitiesAndEquityMinor,
      currentYearEarningsMinor,
      priorYearEarningsMinor,
      balanced: differenceMinor === 0,
      differenceMinor,
      notes,
    };
  }

  private section(
    key: BalanceSheetSection["key"],
    klass: AccountClass,
    labelKey: "section.assets" | "section.liabilities" | "section.equity",
    movements: readonly AccountMovement[],
    mode: LabelMode,
  ): BalanceSheetSection {
    const lines: BalanceSheetLine[] = [];
    let totalMinor = 0;

    for (const m of movements) {
      if (classOf(m.accountType) !== klass) continue;
      const amountMinor = classSigned(m.accountType, m.debitMinor, m.creditMinor);
      totalMinor += amountMinor;
      lines.push({
        accountId: m.accountId,
        code: m.code,
        name: m.name,
        accountType: m.accountType,
        computed: false,
        tag: null,
        amountMinor,
        isContra: m.accountType === "CONTRA_ASSET" || m.accountType === "CONTRA_LIABILITY",
      });
    }

    lines.sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
    return { key, label: label(labelKey, mode), lines, totalMinor };
  }

  async csv(orgId: string, query: BalanceSheetQuery): Promise<string> {
    const report = await this.run(orgId, query);
    const c = report.currency;

    const rows: (string | number)[][] = [];
    for (const section of [report.assets, report.liabilities, report.equity]) {
      for (const line of section.lines) {
        rows.push([
          section.label,
          line.code ?? "",
          line.name,
          line.computed ? "computed" : "posted",
          csvMoney(line.amountMinor, c),
        ]);
      }
      rows.push([section.label, "", `TOTAL ${section.label}`, "", csvMoney(section.totalMinor, c)]);
    }
    rows.push([
      "",
      "",
      `${report.liabilities.label} + ${report.equity.label}`,
      "",
      csvMoney(report.liabilitiesAndEquityMinor, c),
    ]);

    return withCsvPreamble(
      [
        ["Report", report.title],
        ["As of", report.asOf],
        ["Fiscal year", report.fiscalYear.name],
        ["Currency", c],
        ["Balanced", report.balanced ? "yes" : "no"],
        ["Difference", csvMoney(report.differenceMinor, c)],
        ...report.notes.map((n, i) => [`Note ${i + 1}`, n] as const),
      ],
      toCsv(["Section", "Account code", "Line", "Source", "Amount"], rows),
    );
  }
}
