import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { GlAccountType } from "../../../db/schema";
import { BooksService } from "../kernel/books.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { csvMoney, toCsv, withCsvPreamble } from "./report-csv";
import {
  accountTypeLabelKey,
  label,
  type LabelMode,
  type ReportLabelKey,
} from "./report-labels";
import {
  ledgerSigned,
  readAccountMovementsWithZeros,
  resolveReportBook,
} from "./report-queries";

export interface TrialBalanceQuery {
  asOf: string;
  bookId?: string;
  /**
   * Accounts nothing has posted to are hidden by default — a founder's chart
   * has ~40 accounts and three of them have moved. Toggle on for the
   * accountant's full-chart view.
   */
  includeZeroActivity?: boolean;
  labelMode?: LabelMode;
  /** Narrow to one branch or project (PRD 06 S4). */
  branchId?: string;
  projectId?: number;
}

export interface TrialBalanceLine {
  accountId: string;
  code: string;
  name: string;
  accountType: GlAccountType;
  accountTypeLabel: string;
  /** Closing balance, netted onto whichever side it sits. Never both. */
  debitMinor: number;
  creditMinor: number;
  /** Gross activity, so "no activity" and "nets to zero" stay distinguishable. */
  movementDebitMinor: number;
  movementCreditMinor: number;
}

export interface TrialBalanceReport {
  reportKey: "trial_balance";
  title: string;
  labelMode: LabelMode;
  bookId: string;
  currency: string;
  asOf: string;
  includeZeroActivity: boolean;
  columns: { account: string; debit: string; credit: string };
  lines: TrialBalanceLine[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  /**
   * The whole point of the report. Debits equal credits or the ledger is
   * broken; there is no stored balance that could make this true while the
   * journals say otherwise.
   */
  balanced: boolean;
  differenceMinor: number;
  /**
   * True when a dimension filter is narrowing the report. A dimension lives on
   * the journal line, not the account, and nothing requires both sides of a
   * journal to carry the same one — so a filtered trial balance is a real slice
   * of activity that is **not** expected to balance. Without this flag a reader
   * would see `balanced: false` and reasonably conclude the ledger is broken.
   */
  filtered: boolean;
  notes: string[];
}

/**
 * Trial balance — closing debit and credit per posting account as of a date.
 *
 * Computed from `gl_journal_lines` on every request. PRD 06 forbids a balances
 * table, and this service is why it can: there is nothing to drift.
 */
@Injectable()
export class TrialBalanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  async run(orgId: string, query: TrialBalanceQuery): Promise<TrialBalanceReport> {
    const asOf = assertIsoDate(query.asOf);
    const mode: LabelMode = query.labelMode ?? "founder";
    const includeZeroActivity = query.includeZeroActivity ?? false;
    const filtered = Boolean(query.branchId) || query.projectId !== undefined;
    const book = await resolveReportBook(this.books, orgId, query.bookId);

    const movements = await readAccountMovementsWithZeros(
      this.db,
      { orgId, bookId: book.id, to: asOf, branchId: query.branchId, projectId: query.projectId },
      includeZeroActivity,
    );

    let totalDebitMinor = 0;
    let totalCreditMinor = 0;

    const lines: TrialBalanceLine[] = movements.map((m) => {
      const signed = ledgerSigned(m.debitMinor, m.creditMinor);
      const debitMinor = signed > 0 ? signed : 0;
      const creditMinor = signed < 0 ? -signed : 0;
      totalDebitMinor += debitMinor;
      totalCreditMinor += creditMinor;

      return {
        accountId: m.accountId,
        code: m.code,
        name: m.name,
        accountType: m.accountType,
        accountTypeLabel: label(accountTypeLabelKey(m.accountType), mode),
        debitMinor,
        creditMinor,
        movementDebitMinor: m.debitMinor,
        movementCreditMinor: m.creditMinor,
      };
    });

    return {
      reportKey: "trial_balance",
      title: label("report.trial_balance", mode),
      labelMode: mode,
      bookId: book.id,
      currency: book.baseCurrency,
      asOf,
      includeZeroActivity,
      columns: {
        account: label("column.account", mode),
        debit: label("column.debit", mode),
        credit: label("column.credit", mode),
      },
      lines,
      totalDebitMinor,
      totalCreditMinor,
      balanced: totalDebitMinor === totalCreditMinor,
      differenceMinor: totalDebitMinor - totalCreditMinor,
      filtered,
      notes: filtered
        ? [
            "Narrowed to a branch or project. A dimension sits on the journal line, " +
              "not the account, so this slice is not expected to balance.",
          ]
        : [],
    };
  }

  async csv(orgId: string, query: TrialBalanceQuery): Promise<string> {
    const report = await this.run(orgId, query);
    const c = report.currency;
    const heading = (key: ReportLabelKey) => label(key, report.labelMode);

    const body = toCsv(
      ["Account code", heading("column.account"), "Type", heading("column.debit"), heading("column.credit")],
      [
        ...report.lines.map((l) => [
          l.code,
          l.name,
          l.accountTypeLabel,
          csvMoney(l.debitMinor, c),
          csvMoney(l.creditMinor, c),
        ]),
        [
          "",
          "TOTAL",
          "",
          csvMoney(report.totalDebitMinor, c),
          csvMoney(report.totalCreditMinor, c),
        ],
      ],
    );

    return withCsvPreamble(
      [
        ["Report", report.title],
        ["As of", report.asOf],
        ["Currency", c],
        ["Balanced", report.balanced ? "yes" : "no"],
        ["Difference", csvMoney(report.differenceMinor, c)],
      ],
      body,
    );
  }
}
