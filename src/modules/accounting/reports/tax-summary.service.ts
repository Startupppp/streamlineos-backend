import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { apDocuments, arDocuments, taxDocumentLines, type TaxGlRole } from "../../../db/schema";
import { BooksService } from "../kernel/books.service";
import { assertIsoDate, compareDates } from "../kernel/fiscal-calendar";
import { csvMoney, toCsv, withCsvPreamble } from "./report-csv";
import { label, taxRoleLabelKey, type LabelMode } from "./report-labels";
import { resolveReportBook } from "./report-queries";

/** Roles that increase what is owed to the authority. */
const OUTPUT_ROLES: ReadonlySet<TaxGlRole> = new Set<TaxGlRole>([
  "output_payable",
  "reverse_charge_output",
]);
/** Roles that reduce it. */
const RECOVERABLE_ROLES: ReadonlySet<TaxGlRole> = new Set<TaxGlRole>([
  "input_recoverable",
  "reverse_charge_input",
]);

export interface TaxSummaryQuery {
  from: string;
  to: string;
  bookId?: string;
  labelMode?: LabelMode;
}

export interface TaxSummaryRow {
  glRole: TaxGlRole;
  glRoleLabel: string;
  component: string;
  jurisdiction: string;
  rateBp: number;
  currency: string;
  taxableMinor: number;
  taxMinor: number;
  documentCount: number;
}

export interface TaxSummaryCurrencyTotals {
  currency: string;
  taxableMinor: number;
  taxMinor: number;
  outputTaxMinor: number;
  recoverableInputTaxMinor: number;
  blockedInputTaxMinor: number;
  withheldTaxMinor: number;
  /** Output minus recoverable input. Blocked input and withholding sit outside. */
  netPayableMinor: number;
}

export interface TaxSummaryReport {
  reportKey: "tax_summary";
  title: string;
  labelMode: LabelMode;
  bookId: string;
  currency: string;
  from: string;
  to: string;
  rows: TaxSummaryRow[];
  byRole: Array<{ glRole: TaxGlRole; label: string; taxableMinor: number; taxMinor: number }>;
  byComponent: Array<{ component: string; taxableMinor: number; taxMinor: number }>;
  byCurrency: TaxSummaryCurrencyTotals[];
  /** Totals for the book's base currency. See `byCurrency` for the rest. */
  totals: TaxSummaryCurrencyTotals;
  notes: string[];
}

/**
 * Tax summary for a period, read from the **frozen** `tax_document_lines`.
 *
 * Determination is never re-run here. The engine's verdict was written at post
 * time and this report reads it back verbatim, so a rate corrected next month
 * cannot rewrite a return that has already been filed. That is the single most
 * important property of this file and the reason it does not import
 * `TaxService.determine`.
 */
@Injectable()
export class TaxSummaryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  async run(orgId: string, query: TaxSummaryQuery): Promise<TaxSummaryReport> {
    const from = assertIsoDate(query.from);
    const to = assertIsoDate(query.to);
    if (compareDates(from, to) > 0) {
      throw new BadRequestException("`from` must not be after `to`");
    }

    const mode: LabelMode = query.labelMode ?? "founder";
    const book = await resolveReportBook(this.books, orgId, query.bookId);

    // The document's own accounting date, not when the tax row was written —
    // a bill entered in April for a March supply belongs in March's return.
    const documentDate = sql<string>`coalesce(${arDocuments.issueDate}, ${apDocuments.issueDate}, (${taxDocumentLines.createdAt})::date)`;

    const rows = await this.db
      .select({
        glRole: taxDocumentLines.glRole,
        component: taxDocumentLines.component,
        jurisdiction: taxDocumentLines.jurisdiction,
        rateBp: taxDocumentLines.rateBp,
        currency: taxDocumentLines.currency,
        taxableMinor: sql<string>`coalesce(sum(${taxDocumentLines.taxableMinor}), 0)::bigint`,
        taxMinor: sql<string>`coalesce(sum(${taxDocumentLines.taxMinor}), 0)::bigint`,
        documentCount: sql<string>`count(distinct ${taxDocumentLines.documentId})::bigint`,
      })
      .from(taxDocumentLines)
      .leftJoin(
        arDocuments,
        and(
          eq(arDocuments.id, taxDocumentLines.documentId),
          eq(arDocuments.bookId, taxDocumentLines.bookId),
        ),
      )
      .leftJoin(
        apDocuments,
        and(
          eq(apDocuments.id, taxDocumentLines.documentId),
          eq(apDocuments.bookId, taxDocumentLines.bookId),
        ),
      )
      .where(
        and(
          eq(taxDocumentLines.orgId, orgId),
          eq(taxDocumentLines.bookId, book.id),
          sql`${documentDate} >= ${from}`,
          sql`${documentDate} <= ${to}`,
        ),
      )
      .groupBy(
        taxDocumentLines.glRole,
        taxDocumentLines.component,
        taxDocumentLines.jurisdiction,
        taxDocumentLines.rateBp,
        taxDocumentLines.currency,
      )
      .orderBy(asc(taxDocumentLines.glRole), asc(taxDocumentLines.component));

    const detail: TaxSummaryRow[] = rows.map((r) => ({
      glRole: r.glRole,
      glRoleLabel: label(taxRoleLabelKey(r.glRole), mode),
      component: r.component,
      jurisdiction: r.jurisdiction,
      rateBp: r.rateBp,
      currency: r.currency,
      taxableMinor: Number(r.taxableMinor),
      taxMinor: Number(r.taxMinor),
      documentCount: Number(r.documentCount),
    }));

    const byRole = new Map<TaxGlRole, { taxableMinor: number; taxMinor: number }>();
    const byComponent = new Map<string, { taxableMinor: number; taxMinor: number }>();
    const byCurrency = new Map<string, TaxSummaryCurrencyTotals>();

    for (const row of detail) {
      const role = byRole.get(row.glRole) ?? { taxableMinor: 0, taxMinor: 0 };
      role.taxableMinor += row.taxableMinor;
      role.taxMinor += row.taxMinor;
      byRole.set(row.glRole, role);

      const component = byComponent.get(row.component) ?? { taxableMinor: 0, taxMinor: 0 };
      component.taxableMinor += row.taxableMinor;
      component.taxMinor += row.taxMinor;
      byComponent.set(row.component, component);

      const totals = byCurrency.get(row.currency) ?? emptyCurrencyTotals(row.currency);
      totals.taxableMinor += row.taxableMinor;
      totals.taxMinor += row.taxMinor;
      if (OUTPUT_ROLES.has(row.glRole)) totals.outputTaxMinor += row.taxMinor;
      if (RECOVERABLE_ROLES.has(row.glRole)) totals.recoverableInputTaxMinor += row.taxMinor;
      if (row.glRole === "blocked_input") totals.blockedInputTaxMinor += row.taxMinor;
      if (row.glRole === "withheld") totals.withheldTaxMinor += row.taxMinor;
      totals.netPayableMinor = totals.outputTaxMinor - totals.recoverableInputTaxMinor;
      byCurrency.set(row.currency, totals);
    }

    const notes: string[] = [
      "Read from frozen tax lines written when each document was posted. Determination is never " +
        "re-run, so a rate changed later cannot alter a period already reported.",
      "Amounts are in each document's transaction currency and are not converted. Totals are " +
        "grouped by currency for that reason.",
    ];
    const foreign = [...byCurrency.keys()].filter((c) => c !== book.baseCurrency);
    if (foreign.length > 0) {
      notes.push(
        `This period contains tax lines in ${foreign.join(", ")} as well as ${book.baseCurrency}. ` +
          "The headline totals cover the base currency only.",
      );
    }

    return {
      reportKey: "tax_summary",
      title: label("report.tax_summary", mode),
      labelMode: mode,
      bookId: book.id,
      currency: book.baseCurrency,
      from,
      to,
      rows: detail,
      byRole: [...byRole.entries()].map(([glRole, v]) => ({
        glRole,
        label: label(taxRoleLabelKey(glRole), mode),
        ...v,
      })),
      byComponent: [...byComponent.entries()]
        .map(([component, v]) => ({ component, ...v }))
        .sort((a, b) => a.component.localeCompare(b.component)),
      byCurrency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      totals: byCurrency.get(book.baseCurrency) ?? emptyCurrencyTotals(book.baseCurrency),
      notes,
    };
  }

  async csv(orgId: string, query: TaxSummaryQuery): Promise<string> {
    const report = await this.run(orgId, query);

    const rows: (string | number)[][] = report.rows.map((r) => [
      r.glRoleLabel,
      r.glRole,
      r.component,
      r.jurisdiction,
      (r.rateBp / 100).toFixed(2),
      r.currency,
      csvMoney(r.taxableMinor, r.currency),
      csvMoney(r.taxMinor, r.currency),
      r.documentCount,
    ]);

    for (const totals of report.byCurrency) {
      rows.push([
        "TOTAL",
        "",
        "",
        "",
        "",
        totals.currency,
        csvMoney(totals.taxableMinor, totals.currency),
        csvMoney(totals.taxMinor, totals.currency),
        "",
      ]);
    }

    return withCsvPreamble(
      [
        ["Report", report.title],
        ["From", report.from],
        ["To", report.to],
        ["Base currency", report.currency],
        ["Output tax", csvMoney(report.totals.outputTaxMinor, report.currency)],
        ["Recoverable input tax", csvMoney(report.totals.recoverableInputTaxMinor, report.currency)],
        ["Blocked input tax", csvMoney(report.totals.blockedInputTaxMinor, report.currency)],
        ["Withheld tax", csvMoney(report.totals.withheldTaxMinor, report.currency)],
        ["Net payable", csvMoney(report.totals.netPayableMinor, report.currency)],
        ...report.notes.map((n, i) => [`Note ${i + 1}`, n] as const),
      ],
      toCsv(
        [
          "Role",
          "Role key",
          "Component",
          "Jurisdiction",
          "Rate %",
          "Currency",
          label("column.taxable", report.labelMode),
          label("column.tax", report.labelMode),
          "Documents",
        ],
        rows,
      ),
    );
  }
}

function emptyCurrencyTotals(currency: string): TaxSummaryCurrencyTotals {
  return {
    currency,
    taxableMinor: 0,
    taxMinor: 0,
    outputTaxMinor: 0,
    recoverableInputTaxMinor: 0,
    blockedInputTaxMinor: 0,
    withheldTaxMinor: 0,
    netPayableMinor: 0,
  };
}
