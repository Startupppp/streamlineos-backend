import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { addDays, assertIsoDate, compareDates } from "../kernel/fiscal-calendar";
import { csvMoney, toCsv, withCsvPreamble } from "./report-csv";
import { label, type LabelMode } from "./report-labels";
import {
  dayBefore,
  daysBetween,
  fiscalYearWindowFor,
  readAccountMovementsWithZeros,
  resolveReportBook,
  type FiscalYearWindow,
} from "./report-queries";
import {
  buildProfitLossSection,
  type ProfitLossLine,
  type ProfitLossSection,
} from "./profit-loss-section";

export interface ProfitLossQuery {
  from: string;
  to: string;
  bookId?: string;
  /** Adds the immediately preceding period of the same length as a column. */
  comparative?: boolean;
  /**
   * Defaults to true. See `clampedToFiscalYear` on the report for why this is
   * on rather than off.
   */
  clampToFiscalYear?: boolean;
  includeZeroActivity?: boolean;
  labelMode?: LabelMode;
  /** Narrow to one branch or project (PRD 06 S4). */
  branchId?: string;
  projectId?: number;
}

export type { ProfitLossSection };

export interface ProfitLossReport {
  reportKey: "profit_loss";
  title: string;
  labelMode: LabelMode;
  bookId: string;
  currency: string;
  /** What the caller asked for, kept so a clamp is never silent. */
  requestedFrom: string;
  from: string;
  to: string;
  fiscalYear: FiscalYearWindow;
  clampedToFiscalYear: boolean;
  comparative: { from: string; to: string } | null;
  columns: { account: string; thisPeriod: string; lastPeriod: string; change: string };
  income: ProfitLossSection;
  expense: ProfitLossSection;
  netProfitLabel: string;
  netProfitMinor: number;
  priorNetProfitMinor: number | null;
  notes: string[];
}

/**
 * Profit and loss for a date range.
 *
 * Two things this deliberately does not do:
 *
 * 1. It never reads an as-of balance. A P&L is a **movement** report; asking
 *    for cumulative balances is how last year's revenue quietly reappears in
 *    this year's income.
 * 2. When the requested range starts before the fiscal year containing `to`,
 *    the start is clamped to the fiscal-year start by default and the report
 *    says so. PRD 06 M2 is explicit that a P&L must not carry a prior fiscal
 *    year's result; a caller who genuinely wants a rolling multi-year window
 *    passes `clampToFiscalYear: false` and gets the raw range, labelled.
 */
@Injectable()
export class ProfitLossService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  async run(orgId: string, query: ProfitLossQuery): Promise<ProfitLossReport> {
    const requestedFrom = assertIsoDate(query.from);
    const to = assertIsoDate(query.to);
    if (compareDates(requestedFrom, to) > 0) {
      throw new BadRequestException("`from` must not be after `to`");
    }

    const mode: LabelMode = query.labelMode ?? "founder";
    const includeZeroActivity = query.includeZeroActivity ?? false;
    const clampToFiscalYear = query.clampToFiscalYear ?? true;
    const book = await resolveReportBook(this.books, orgId, query.bookId);

    const fiscalYear = await fiscalYearWindowFor(this.db, book, to);
    const crosses = compareDates(requestedFrom, fiscalYear.startsOn) < 0;
    const clampedToFiscalYear = clampToFiscalYear && crosses;
    const from = clampedToFiscalYear ? fiscalYear.startsOn : requestedFrom;

    const movements = await readAccountMovementsWithZeros(
      this.db,
      { orgId, bookId: book.id, from, to, branchId: query.branchId, projectId: query.projectId },
      includeZeroActivity,
    );

    // The comparative is the same number of days immediately before the
    // period. It may cross a fiscal-year start — that is the point of a
    // comparative, so it is never clamped, and the note says so.
    const lengthDays = daysBetween(from, to);
    const comparative = query.comparative
      ? { from: addDays(dayBefore(from), -lengthDays), to: dayBefore(from) }
      : null;
    const priorMovements = comparative
      ? await readAccountMovementsWithZeros(
          this.db,
          { orgId, bookId: book.id, from: comparative.from, to: comparative.to },
          includeZeroActivity,
        )
      : [];
    const priorByAccount = new Map(priorMovements.map((m) => [m.accountId, m]));

    const income = buildProfitLossSection("income", "section.income", movements, priorByAccount, comparative !== null, mode);
    const expense = buildProfitLossSection("expense", "section.expense", movements, priorByAccount, comparative !== null, mode);

    const notes: string[] = [];
    if (clampedToFiscalYear) {
      notes.push(
        `The requested start ${requestedFrom} fell in an earlier fiscal year. It was moved to ` +
          `${fiscalYear.startsOn}, the start of ${fiscalYear.name}, so no prior year's result is ` +
          "included. Pass clampToFiscalYear=false for the raw range.",
      );
    } else if (crosses) {
      notes.push(
        `This range starts before ${fiscalYear.startsOn} and therefore spans more than one fiscal ` +
          "year. It is not a statutory profit and loss for any single year.",
      );
    }
    if (!fiscalYear.opened) {
      notes.push(
        `No fiscal year has been opened around ${to}; ${fiscalYear.name} was derived from the ` +
          "book's calendar.",
      );
    }
    if (comparative) {
      notes.push(
        `The comparative column covers ${comparative.from} to ${comparative.to} and may fall in ` +
          "an earlier fiscal year.",
      );
    }

    return {
      reportKey: "profit_loss",
      title: label("report.profit_loss", mode),
      labelMode: mode,
      bookId: book.id,
      currency: book.baseCurrency,
      requestedFrom,
      from,
      to,
      fiscalYear,
      clampedToFiscalYear,
      comparative,
      columns: {
        account: label("column.account", mode),
        thisPeriod: label("column.this_period", mode),
        lastPeriod: label("column.last_period", mode),
        change: label("column.change", mode),
      },
      income,
      expense,
      netProfitLabel: label("section.net_profit", mode),
      netProfitMinor: income.totalMinor - expense.totalMinor,
      priorNetProfitMinor:
        income.priorTotalMinor === null || expense.priorTotalMinor === null
          ? null
          : income.priorTotalMinor - expense.priorTotalMinor,
      notes,
    };
  }

  async csv(orgId: string, query: ProfitLossQuery): Promise<string> {
    const report = await this.run(orgId, query);
    const c = report.currency;
    const comparative = report.comparative !== null;

    const headers = [
      "Section",
      "Account code",
      report.columns.account,
      report.columns.thisPeriod,
      ...(comparative ? [report.columns.lastPeriod, report.columns.change] : []),
    ];

    const rows: (string | number)[][] = [];
    for (const section of [report.income, report.expense]) {
      for (const line of section.lines) {
        rows.push([
          section.label,
          line.code,
          line.name,
          csvMoney(line.amountMinor, c),
          ...(comparative
            ? [csvMoney(line.priorAmountMinor ?? 0, c), csvMoney(line.varianceMinor ?? 0, c)]
            : []),
        ]);
      }
      rows.push([
        section.label,
        "",
        `TOTAL ${section.label}`,
        csvMoney(section.totalMinor, c),
        ...(comparative ? [csvMoney(section.priorTotalMinor ?? 0, c), ""] : []),
      ]);
    }
    rows.push([
      "",
      "",
      report.netProfitLabel,
      csvMoney(report.netProfitMinor, c),
      ...(comparative ? [csvMoney(report.priorNetProfitMinor ?? 0, c), ""] : []),
    ]);

    return withCsvPreamble(
      [
        ["Report", report.title],
        ["From", report.from],
        ["To", report.to],
        ["Fiscal year", report.fiscalYear.name],
        ["Currency", c],
        ...report.notes.map((n, i) => [`Note ${i + 1}`, n] as const),
      ],
      toCsv(headers, rows),
    );
  }
}
