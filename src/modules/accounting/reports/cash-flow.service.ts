import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { GlSystemTag } from "../../../db/schema";
import { BooksService } from "../kernel/books.service";
import { assertIsoDate, compareDates } from "../kernel/fiscal-calendar";
import { csvMoney, toCsv, withCsvPreamble } from "./report-csv";
import { label, type LabelMode, type ReportLabelKey } from "./report-labels";
import {
  cashBalanceOf,
  dayBefore,
  ledgerSigned,
  negated,
  profitOf,
  readAccountMovements,
  resolveReportBook,
  type AccountMovement,
} from "./report-queries";

/**
 * Accounts whose movement is a working-capital timing difference rather than
 * cash. Resolved by system tag, never by code — a book that renumbered its
 * chart must still produce the same statement (PRD 01 S3).
 */
const TAX_ACCOUNT_TAGS: ReadonlySet<GlSystemTag> = new Set<GlSystemTag>([
  "vat_input",
  "vat_output",
  "sales_tax_payable",
  "wht_payable",
  "gst_input_cgst",
  "gst_input_sgst",
  "gst_input_igst",
  "gst_input_utgst",
  "gst_input_cess",
  "gst_output_cgst",
  "gst_output_sgst",
  "gst_output_igst",
  "gst_output_utgst",
  "gst_output_cess",
]);

/**
 * What v1 of the indirect method does **not** model, stated in the payload
 * rather than in a doc nobody opens.
 *
 * A cash flow statement that quietly forces itself to agree is worse than one
 * that says where its own edges are: the first is trusted and wrong, the
 * second is understood. Everything this method cannot explain lands in a
 * single visible "other movements" line, and these strings say why.
 */
export const CASH_FLOW_LIMITATIONS: readonly string[] = Object.freeze([
  "Activities are not split into operating, investing and financing. Capital injections, loans, " +
    "asset purchases and drawings all fall into 'other movements'.",
  "Working capital covers the AR control, the AP control and tax accounts only. Inventory, " +
    "prepayments, accruals, employee advances and other balance-sheet movements are not modelled.",
  "The only non-cash item added back is depreciation, and only where an account tagged " +
    "depreciation_expense has activity. Amortisation, provisions, impairments and unrealised FX " +
    "are not identified.",
  "Foreign-exchange effects on cash are not separated out; they sit inside the movement of the " +
    "cash accounts themselves.",
  "Cash is every GL account flagged is_cash. There is no restricted-cash or cash-equivalent " +
    "distinction.",
  "Every figure is a movement in the general ledger over the requested dates. This is not a " +
    "bank-statement-derived cash flow and it will not match a bank feed that has unreconciled items.",
]);

export interface CashFlowQuery {
  from: string;
  to: string;
  bookId?: string;
  labelMode?: LabelMode;
}

export interface CashFlowLine {
  key: string;
  label: string;
  /** Positive increases cash, negative reduces it. */
  amountMinor: number;
  /** Accounts that produced the figure, so a number can be traced. */
  accountCodes: string[];
}

export interface CashFlowSection {
  key: "operating" | "non_cash" | "working_capital" | "unmodelled";
  label: string;
  lines: CashFlowLine[];
  totalMinor: number;
}

export interface CashFlowReport {
  reportKey: "cash_flow";
  title: string;
  method: "indirect";
  labelMode: LabelMode;
  bookId: string;
  currency: string;
  from: string;
  to: string;
  sections: CashFlowSection[];
  netIncomeMinor: number;
  nonCashMinor: number;
  workingCapitalMinor: number;
  /** Net income plus non-cash plus working capital. */
  operatingCashMinor: number;
  /** The part of the real cash movement this method cannot account for. */
  otherMovementsMinor: number;
  openingCashMinor: number;
  netMovementMinor: number;
  closingCashMinor: number;
  /** `openingCash + netMovement === closingCash`. */
  reconciles: boolean;
  reconciliationDifferenceMinor: number;
  limitations: readonly string[];
}

/**
 * Cash flow, indirect method, v1 scope.
 *
 * Net profit, adjusted for the non-cash items we can actually identify and the
 * working-capital movements we actually track, reconciled against the real
 * movement of the cash accounts. Whatever is left over is shown as "other
 * movements" instead of being buried — see `CASH_FLOW_LIMITATIONS`.
 */
@Injectable()
export class CashFlowService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  async run(orgId: string, query: CashFlowQuery): Promise<CashFlowReport> {
    const from = assertIsoDate(query.from);
    const to = assertIsoDate(query.to);
    if (compareDates(from, to) > 0) {
      throw new BadRequestException("`from` must not be after `to`");
    }

    const mode: LabelMode = query.labelMode ?? "founder";
    const book = await resolveReportBook(this.books, orgId, query.bookId);
    const scope = { orgId, bookId: book.id };

    const period = await readAccountMovements(this.db, { ...scope, from, to });
    const opening = await readAccountMovements(this.db, { ...scope, to: dayBefore(from) });
    const closing = await readAccountMovements(this.db, { ...scope, to });

    const openingCashMinor = cashBalanceOf(opening);
    const closingCashMinor = cashBalanceOf(closing);

    const netIncomeMinor = profitOf(period);

    // A debit to an asset consumes cash; a credit to a liability provides it.
    // `-(debit - credit)` is both of those at once, which is why AR, AP and
    // tax can share one rule instead of three sign conventions to get wrong.
    const workingCapitalAdjustment = (rows: readonly AccountMovement[]) =>
      negated(rows.reduce((total, m) => total + ledgerSigned(m.debitMinor, m.creditMinor), 0));

    const arRows = period.filter((m) => m.systemTag === "ar_control");
    const apRows = period.filter((m) => m.systemTag === "ap_control");
    const taxRows = period.filter((m) => m.systemTag && TAX_ACCOUNT_TAGS.has(m.systemTag));
    const depreciationRows = period.filter((m) => m.systemTag === "depreciation_expense");

    const arMinor = workingCapitalAdjustment(arRows);
    const apMinor = workingCapitalAdjustment(apRows);
    const taxMinor = workingCapitalAdjustment(taxRows);
    const depreciationMinor = depreciationRows.reduce(
      (total, m) => total + ledgerSigned(m.debitMinor, m.creditMinor),
      0,
    );

    const line = (key: ReportLabelKey, amountMinor: number, rows: readonly AccountMovement[]) => ({
      key: key.replace(/^line\./, ""),
      label: label(key, mode),
      amountMinor,
      accountCodes: rows.map((r) => r.code),
    });

    const nonCashLines: CashFlowLine[] = [];
    if (depreciationMinor !== 0) {
      nonCashLines.push(line("line.depreciation", depreciationMinor, depreciationRows));
    }

    const workingCapitalLines: CashFlowLine[] = [
      line("line.ar_movement", arMinor, arRows),
      line("line.ap_movement", apMinor, apRows),
      line("line.tax_movement", taxMinor, taxRows),
    ];

    const nonCashMinor = depreciationMinor;
    const workingCapitalMinor = arMinor + apMinor + taxMinor;
    const operatingCashMinor = netIncomeMinor + nonCashMinor + workingCapitalMinor;
    const otherMovementsMinor = closingCashMinor - openingCashMinor - operatingCashMinor;
    const netMovementMinor = operatingCashMinor + otherMovementsMinor;

    const sections: CashFlowSection[] = [
      {
        key: "operating",
        label: label("section.operating", mode),
        lines: [line("line.net_income", netIncomeMinor, [])],
        totalMinor: netIncomeMinor,
      },
      {
        key: "non_cash",
        label: label("section.non_cash", mode),
        lines: nonCashLines,
        totalMinor: nonCashMinor,
      },
      {
        key: "working_capital",
        label: label("section.working_capital", mode),
        lines: workingCapitalLines,
        totalMinor: workingCapitalMinor,
      },
      {
        key: "unmodelled",
        label: label("section.unmodelled", mode),
        lines: [line("line.other_movements", otherMovementsMinor, [])],
        totalMinor: otherMovementsMinor,
      },
    ];

    const reconciliationDifferenceMinor =
      openingCashMinor + netMovementMinor - closingCashMinor;

    return {
      reportKey: "cash_flow",
      title: label("report.cash_flow", mode),
      method: "indirect",
      labelMode: mode,
      bookId: book.id,
      currency: book.baseCurrency,
      from,
      to,
      sections,
      netIncomeMinor,
      nonCashMinor,
      workingCapitalMinor,
      operatingCashMinor,
      otherMovementsMinor,
      openingCashMinor,
      netMovementMinor,
      closingCashMinor,
      reconciles: reconciliationDifferenceMinor === 0,
      reconciliationDifferenceMinor,
      limitations: CASH_FLOW_LIMITATIONS,
    };
  }

  async csv(orgId: string, query: CashFlowQuery): Promise<string> {
    const report = await this.run(orgId, query);
    const c = report.currency;

    const rows: (string | number)[][] = [];
    for (const section of report.sections) {
      for (const l of section.lines) {
        rows.push([section.label, l.label, l.accountCodes.join(" "), csvMoney(l.amountMinor, c)]);
      }
      rows.push([section.label, `TOTAL ${section.label}`, "", csvMoney(section.totalMinor, c)]);
    }
    rows.push([
      "",
      label("line.opening_cash", report.labelMode),
      "",
      csvMoney(report.openingCashMinor, c),
    ]);
    rows.push([
      "",
      label("line.net_movement", report.labelMode),
      "",
      csvMoney(report.netMovementMinor, c),
    ]);
    rows.push([
      "",
      label("line.closing_cash", report.labelMode),
      "",
      csvMoney(report.closingCashMinor, c),
    ]);

    return withCsvPreamble(
      [
        ["Report", report.title],
        ["Method", "Indirect"],
        ["From", report.from],
        ["To", report.to],
        ["Currency", c],
        ["Reconciles", report.reconciles ? "yes" : "no"],
        ...report.limitations.map((l, i) => [`Limitation ${i + 1}`, l] as const),
      ],
      toCsv(["Section", "Line", "Accounts", "Amount"], rows),
    );
  }
}
