import { Injectable, Logger } from "@nestjs/common";
import { PostingCommandService } from "../accounting/adapters/posting-command.service";
import {
  AdapterRejection,
  type PostingCommandLine,
} from "../accounting/adapters/posting-command.types";
import { BooksService } from "../accounting/kernel/books.service";
import { FxService } from "../accounting/kernel/fx.service";
import type { DbOrTx } from "../accounting/kernel/sequence.service";
import { convert, money } from "../accounting/kernel/money";
import type { RecordPaymentInput } from "./dto/invoice-write.schemas";

/**
 * This module's hand-off to accounting.
 *
 * Everything the retired `JournalPostingService` did for invoices happens here,
 * on the new kernel and through the one seam accounting exposes:
 * `PostingCommandService`. Nothing below names a GL account id — every line is a
 * `GlSystemTag` resolved against the organisation's own chart, so a tenant
 * renumbering their accounts cannot break invoicing.
 *
 * Three things the old service did have no successor and are gone rather than
 * approximated:
 *
 * - `seedChartOfAccountsForOrg` — the chart is now seeded once, by
 *   `AccountingSetupService`, when an organisation enables accounting. A module
 *   posting an invoice does not get to create a chart as a side effect.
 * - `gstSplit` — pure arithmetic with no reason to sit behind a posting
 *   service; it moved to `lib/invoice-helpers.ts`.
 * - the stored `invoices.exchange_rate` — never written by the create path, so
 *   it was always `1`. Conversion reads `gl_fx_rates` through `FxService`
 *   instead, which errors loudly when a rate is missing rather than posting a
 *   foreign-currency invoice at parity.
 *
 * Accounting is opt-in: an organisation that never enabled it has no book, and
 * every method here answers `null` rather than failing the invoice.
 */

/** How a receipt lands in the chart, by the method the money arrived through. */
const RECEIPT_ACCOUNT_TAG: Record<RecordPaymentInput["paymentMethod"], "cash" | "bank" | "psp_clearing" | "undeposited"> = {
  cash: "cash",
  bank_transfer: "bank",
  upi: "bank",
  card: "psp_clearing",
  // A cheque is not in the bank until it clears, and "other" is unknown by
  // definition — both wait in undeposited funds.
  cheque: "undeposited",
  other: "undeposited",
};

export interface InvoiceIssuedPosting {
  invoiceId: number;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  subtotal: number;
  discount: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface PaymentReceiptPosting {
  paymentId: number;
  invoiceId: number;
  invoiceNumber: string;
  paymentDate: string;
  paymentMethod: RecordPaymentInput["paymentMethod"];
  currency: string;
  amount: number;
}

@Injectable()
export class InvoicesPostingService {
  private readonly logger = new Logger(InvoicesPostingService.name);

  constructor(
    private readonly posting: PostingCommandService,
    private readonly books: BooksService,
    private readonly fx: FxService,
  ) {}

  /**
   * The revenue entry, posted when an invoice is issued.
   *
   *   accounts receivable   total                (debit)
   *   sales                 subtotal - discount  (credit)
   *   output GST            cgst / sgst / igst   (credit)
   *
   * The discount nets into revenue: the kernel has no contra-revenue role, and
   * inventing one would put an account in the chart no pack seeds.
   */
  async postInvoiceIssued(
    orgId: string,
    userId: string,
    input: InvoiceIssuedPosting,
    tx?: DbOrTx,
  ): Promise<string | null> {
    const context = await this.conversion(orgId, input.currency, input.invoiceDate, tx);
    if (!context) return null;

    const { toBase, currency } = context;
    const netRevenue = this.round2(input.subtotal - input.discount);

    const lines: PostingCommandLine[] = [
      {
        accountTag: "ar_control",
        debitMinor: toBase(input.total),
        ...this.txnLeg(input.total, currency, context.rate),
        description: `Invoice ${input.invoiceNumber}`,
      },
      {
        accountTag: "sales",
        creditMinor: toBase(netRevenue),
        ...this.txnLeg(netRevenue, currency, context.rate),
        description: `Revenue — invoice ${input.invoiceNumber}`,
      },
    ];

    // GST roles only exist on a chart the India pack seeded. Naming one on a
    // book without it is an error the user must resolve, not something to
    // silently fold into revenue — so no fallback here on purpose.
    for (const [tag, amount, label] of [
      ["gst_output_cgst", input.cgst, "CGST"],
      ["gst_output_sgst", input.sgst, "SGST"],
      ["gst_output_igst", input.igst, "IGST"],
    ] as const) {
      if (amount <= 0) continue;
      lines.push({
        accountTag: tag,
        creditMinor: toBase(amount),
        ...this.txnLeg(amount, currency, context.rate),
        description: `Output ${label} on ${input.invoiceNumber}`,
      });
    }

    this.settleRounding(lines, currency, context.rate);

    return this.submit(
      orgId,
      userId,
      {
        sourceType: "sales_invoice",
        sourceId: String(input.invoiceId),
        purpose: "post",
        journalDate: input.invoiceDate,
        memo: `Invoice ${input.invoiceNumber}`,
        lines,
      },
      tx,
    );
  }

  /**
   * Reverse the revenue entry when an invoice is voided.
   *
   * Never an edit and never a delete: the kernel posts a mirror journal and
   * leaves the original standing. Returns null when there was nothing posted —
   * a draft invoice, or an organisation without accounting.
   */
  async reverseInvoiceIssued(
    orgId: string,
    userId: string,
    invoiceId: number,
    onDate: string,
  ): Promise<string | null> {
    try {
      const result = await this.posting.reverse(
        orgId,
        userId,
        { sourceType: "sales_invoice", sourceId: String(invoiceId), purpose: "post" },
        onDate,
      );
      return result?.journalId ?? null;
    } catch (error) {
      if (this.isBookMissing(error)) return null;
      throw error;
    }
  }

  /**
   * The cash entry, posted when a payment is recorded.
   *
   *   cash / bank / clearing   amount   (debit)
   *   accounts receivable      amount   (credit)
   */
  async postPaymentReceipt(
    orgId: string,
    userId: string,
    input: PaymentReceiptPosting,
    tx?: DbOrTx,
  ): Promise<string | null> {
    const context = await this.conversion(orgId, input.currency, input.paymentDate, tx);
    if (!context) return null;

    const { toBase, currency, rate } = context;
    const baseMinor = toBase(input.amount);

    return this.submit(
      orgId,
      userId,
      {
        sourceType: "receipt",
        sourceId: String(input.paymentId),
        purpose: "post",
        journalDate: input.paymentDate,
        memo: `Payment received — invoice ${input.invoiceNumber}`,
        lines: [
          {
            accountTag: RECEIPT_ACCOUNT_TAG[input.paymentMethod],
            debitMinor: baseMinor,
            ...this.txnLeg(input.amount, currency, rate),
            description: `Receipt for ${input.invoiceNumber}`,
          },
          {
            accountTag: "ar_control",
            creditMinor: baseMinor,
            ...this.txnLeg(input.amount, currency, rate),
            description: `Settles ${input.invoiceNumber}`,
          },
        ],
      },
      tx,
    );
  }

  /**
   * Realised FX on a settled foreign-currency invoice.
   *
   *   gain:  accounts receivable  diff  (debit)   fx gain  diff  (credit)
   *   loss:  fx loss              diff  (debit)   accounts receivable  diff  (credit)
   *
   * The receivable was booked at the invoice-date rate and cleared at the
   * payment-date rate, so a residue is left on the control account; this clears
   * it. Both rates come from the book's own table — a missing rate is reported,
   * never defaulted to 1, which is the whole point of PRD 11.
   */
  async postRealizedFx(
    orgId: string,
    userId: string,
    invoice: { id: number; currency: string; issueDate: string },
    settledAmount: number,
    paymentDate: string,
  ): Promise<string | null> {
    const book = await this.book(orgId);
    if (!book) return null;

    const currency = invoice.currency.toUpperCase();
    const base = book.baseCurrency.toUpperCase();
    if (currency === base) return null;

    const [booked, settled] = await Promise.all([
      this.fx.rateFor(book.id, currency, base, invoice.issueDate),
      this.fx.rateFor(book.id, currency, base, paymentDate),
    ]);
    if (!booked || !settled) {
      this.logger.warn(
        `No exchange rate for ${currency}->${base} around invoice ${invoice.id}; realised FX was not posted`,
      );
      return null;
    }

    const amount = money(Math.round(settledAmount * 100), currency);
    const difference =
      convert(amount, base, settled.rate).minor - convert(amount, base, booked.rate).minor;
    if (difference === 0) return null;

    const gain = difference > 0;
    const magnitude = Math.abs(difference);

    return this.submit(
      orgId,
      userId,
      {
        sourceType: "fx_reval",
        sourceId: String(invoice.id),
        purpose: `realized:${paymentDate}`,
        journalDate: paymentDate,
        memo: `Realised FX on invoice ${invoice.id}`,
        lines: [
          {
            accountTag: gain ? "ar_control" : "fx_loss",
            debitMinor: magnitude,
            currency: base,
            description: gain ? "Realised FX gain" : "Realised FX loss",
          },
          {
            accountTag: gain ? "fx_gain" : "ar_control",
            creditMinor: magnitude,
            currency: base,
            description: gain ? "Realised FX gain" : "Realised FX loss",
          },
        ],
      },
    );
  }

  /* ------------------------------------------------------------ internals */

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private async book(orgId: string, tx?: DbOrTx) {
    try {
      return await this.books.findDefault(orgId, tx);
    } catch (error) {
      if (this.isBookMissing(error)) return null;
      throw error;
    }
  }

  /**
   * Everything needed to express this document's amounts in the book's base
   * currency. Null when the organisation has no book, which is the signal to
   * skip posting rather than to fail the document.
   */
  private async conversion(
    orgId: string,
    documentCurrency: string,
    onDate: string,
    tx?: DbOrTx,
  ): Promise<{ currency: string; rate: string; toBase: (amount: number) => number } | null> {
    const book = await this.book(orgId, tx);
    if (!book) {
      this.logger.debug(
        `Accounting is not enabled for org ${orgId}; nothing was posted for this document`,
      );
      return null;
    }

    const currency = (documentCurrency || book.baseCurrency).toUpperCase();
    const base = book.baseCurrency.toUpperCase();
    // `requireRateFor` throws a 400 naming the missing pair — the correct
    // answer for a foreign-currency invoice with no rate on file.
    const rate =
      currency === base ? "1" : (await this.fx.requireRateFor(book.id, currency, base, onDate, tx)).rate;

    return {
      currency,
      rate,
      toBase: (amount: number) => {
        const minor = money(Math.round(this.round2(amount) * 100), currency);
        return currency === base ? minor.minor : convert(minor, base, rate).minor;
      },
    };
  }

  /** The transaction-currency half of a line; omitted entirely when in base. */
  private txnLeg(amount: number, currency: string, rate: string) {
    if (rate === "1") return { currency };
    return {
      currency,
      txnAmountMinor: Math.round(this.round2(amount) * 100),
      fxRate: rate,
    };
  }

  /**
   * Converting each line separately can lose a minor unit against the total.
   * The kernel balances at zero tolerance, so the residue is posted explicitly
   * to the chart's rounding role rather than papered over — the same thing
   * `ar-documents.service.ts` does for its own documents.
   */
  private settleRounding(lines: PostingCommandLine[], currency: string, rate: string): void {
    if (rate === "1") return;
    const debit = lines.reduce((a, l) => a + (l.debitMinor ?? 0), 0);
    const credit = lines.reduce((a, l) => a + (l.creditMinor ?? 0), 0);
    const difference = debit - credit;
    if (difference === 0) return;

    lines.push({
      accountTag: "rounding",
      ...(difference > 0 ? { creditMinor: difference } : { debitMinor: -difference }),
      description: `Rounding on ${currency} conversion`,
    });
  }

  private async submit(
    orgId: string,
    userId: string,
    command: Parameters<PostingCommandService["submit"]>[2],
    tx?: DbOrTx,
  ): Promise<string | null> {
    try {
      const result = await this.posting.submit(orgId, userId, command, tx);
      return result.journalId;
    } catch (error) {
      if (this.isBookMissing(error)) {
        this.logger.debug(
          `Accounting is not enabled for org ${orgId}; ${command.sourceType} ${command.sourceId} was not posted`,
        );
        return null;
      }
      throw error;
    }
  }

  private isBookMissing(error: unknown): boolean {
    return error instanceof AdapterRejection && error.code === "BOOK_NOT_ENABLED";
  }
}
