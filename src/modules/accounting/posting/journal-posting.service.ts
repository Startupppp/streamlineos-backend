import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ACCOUNT_CODES, type GstSplit, paymentMethodToAccountCode, splitTaxPool } from "../core/posting-rules";
import {
  type DbOrTx,
  type DraftLine,
  type DraftEntry,
  type DraftDecimalLine,
  type DraftDecimalEntry,
  type PersistedEntry,
  type PostInvoiceInput,
  type PostPaymentInput,
  type PostPurchaseBillInput,
  type PostVendorPaymentInput,
  ACCOUNTS_PAYABLE,
  INPUT_CGST,
  INPUT_SGST,
  INPUT_IGST,
  DEFAULT_COA,
  INVOICE_SOURCE_TYPE,
  INVOICE_SEND_SOURCE_EVENT,
} from "./journal-posting.data";
import { compareDecimals, decimalFromNumber, sumDecimals, toDecimal } from "../core/money.util";
import { isUniqueViolation } from "../../../common/db/postgres-error";

export type { DbOrTx, DraftLine, DraftEntry, DraftDecimalLine, DraftDecimalEntry, PersistedEntry, PostInvoiceInput, PostPaymentInput, PostPurchaseBillInput, PostVendorPaymentInput };

@Injectable()
export class JournalPostingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  gstSplit(taxPool: number, supplierStateCode: string, placeOfSupplyStateCode: string): GstSplit {
    return splitTaxPool(taxPool, { supplierStateCode, placeOfSupplyStateCode });
  }

  async seedChartOfAccountsForOrg(orgId: string): Promise<void> {
    const existing = await this.db
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.orgId, orgId))
      .limit(1);
    if (existing.length > 0) return;

    await this.db
      .insert(ledgerAccounts)
      .values(
        DEFAULT_COA.map((row) => ({
          orgId,
          code: row.code,
          name: row.name,
          accountType: row.accountType,
        })),
      )
      .onConflictDoNothing();
  }

  private async nextEntryNumber(orgId: string, year: number, executor: DbOrTx): Promise<string> {
    const prefix = `JE-${year}-`;
    const latest = await executor
      .select({ entryNumber: journalEntries.entryNumber })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, orgId), like(journalEntries.entryNumber, `${prefix}%`)))
      .orderBy(desc(journalEntries.entryNumber))
      .limit(1);

    const last = latest[0]?.entryNumber;
    const lastSeq = last ? parseInt(last.slice(prefix.length), 10) : 0;
    const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
    return `${prefix}${String(nextSeq).padStart(6, "0")}`;
  }

  private toDecimalLines(lines: DraftLine[]): DraftDecimalLine[] {
    return lines.map((line) => ({
      accountCode: line.accountCode,
      debit: decimalFromNumber(line.debit),
      credit: decimalFromNumber(line.credit),
      description: line.description,
    }));
  }

  private assertBalanced(lines: DraftDecimalLine[]): void {
    const totalDebit = sumDecimals(lines.map((l) => l.debit));
    const totalCredit = sumDecimals(lines.map((l) => l.credit));
    if (compareDecimals(totalDebit, totalCredit) !== 0) {
      throw new Error(
        `Unbalanced journal entry: debit=${totalDebit} credit=${totalCredit} (ledger scale)`,
      );
    }
    for (const line of lines) {
      if (compareDecimals(line.debit, "0") < 0 || compareDecimals(line.credit, "0") < 0) {
        throw new Error(`Negative amount in journal line: ${JSON.stringify(line)}`);
      }
      const hasDebit = compareDecimals(line.debit, "0") > 0;
      const hasCredit = compareDecimals(line.credit, "0") > 0;
      if (hasDebit === hasCredit) {
        throw new Error(`Journal line must have exactly one of debit or credit > 0: ${JSON.stringify(line)}`);
      }
    }
  }

  persistJournalEntry(draft: DraftEntry, tx?: DbOrTx): Promise<PersistedEntry> {
    return this.persistDecimalJournalEntry(
      { ...draft, lines: this.toDecimalLines(draft.lines) },
      tx,
    );
  }

  /**
   * The single write path. Amounts arrive as exact ledger-scale strings, so a
   * caller that already holds `numeric(18,4)` text — a reversal reading the
   * entry it reverses — never round-trips money through a double.
   */
  async persistDecimalJournalEntry(draft: DraftDecimalEntry, tx?: DbOrTx): Promise<PersistedEntry> {
    this.assertBalanced(draft.lines);
    const executor: DbOrTx = tx ?? this.db;

    if (draft.sourceId !== null && draft.sourceEvent !== null) {
      const existing = await executor
        .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.orgId, draft.orgId),
            eq(journalEntries.sourceType, draft.sourceType),
            eq(journalEntries.sourceId, draft.sourceId),
            eq(journalEntries.sourceEvent, draft.sourceEvent),
          ),
        )
        .limit(1);
      if (existing[0]) return existing[0];
    }

    const year = new Date(draft.entryDate).getUTCFullYear();
    const codeToId = new Map<string, number>();
    const distinctCodes = Array.from(new Set(draft.lines.map((l) => l.accountCode)));
    const rows = await executor
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.orgId, draft.orgId),
          inArray(ledgerAccounts.code, distinctCodes),
        ),
      );
    for (const row of rows) codeToId.set(row.code, row.id);

    for (const code of distinctCodes) {
      if (!codeToId.has(code)) {
        throw new Error(`Account code ${code} not found for org ${draft.orgId}. Seed COA first.`);
      }
    }

    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const entryNumber = await this.nextEntryNumber(draft.orgId, year, executor);
      try {
        const inserted = await executor
          .insert(journalEntries)
          .values({
            orgId: draft.orgId,
            entryNumber,
            entryDate: draft.entryDate,
            description: draft.description ?? null,
            sourceType: draft.sourceType,
            sourceId: draft.sourceId,
            sourceEvent: draft.sourceEvent,
            status: draft.status ?? "POSTED",
            createdBy: draft.createdBy,
            createdByMembershipId: draft.createdByMembershipId ?? null,
          })
          .returning({ id: journalEntries.id, entryNumber: journalEntries.entryNumber });

        const entry = inserted[0];
        if (!entry) throw new Error("Insert journal entry returned no rows");

        const lineRows = draft.lines.map((line, idx) => {
          const accountId = codeToId.get(line.accountCode);
          if (accountId === undefined) {
            throw new Error(`Account code ${line.accountCode} missing from map`);
          }
          return {
            orgId: draft.orgId,
            entryId: entry.id,
            accountId,
            debit: toDecimal(line.debit),
            credit: toDecimal(line.credit),
            description: line.description ?? null,
            lineOrder: idx,
          };
        });
        await executor.insert(journalLines).values(lineRows);

        return entry;
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === maxAttempts - 1) throw error;
      }
    }
    throw new Error(`Failed to allocate journal entry number after ${maxAttempts} attempts`);
  }

  postInvoiceSend(input: PostInvoiceInput, tx?: DbOrTx): Promise<PersistedEntry> {
    const split = splitTaxPool(input.taxPool, {
      supplierStateCode: input.supplierStateCode,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode,
    });

    const lines: DraftLine[] = [
      { accountCode: ACCOUNT_CODES.accountsReceivable, debit: input.total, credit: 0, description: `Invoice ${input.invoiceNumber}` },
      { accountCode: ACCOUNT_CODES.salesRevenue, debit: 0, credit: Math.max(0, input.subtotal - input.discount), description: `Invoice ${input.invoiceNumber}` },
    ];
    if (split.cgst > 0) lines.push({ accountCode: ACCOUNT_CODES.outputCgst, debit: 0, credit: split.cgst, description: `Invoice ${input.invoiceNumber} CGST` });
    if (split.sgst > 0) lines.push({ accountCode: ACCOUNT_CODES.outputSgst, debit: 0, credit: split.sgst, description: `Invoice ${input.invoiceNumber} SGST` });
    if (split.igst > 0) lines.push({ accountCode: ACCOUNT_CODES.outputIgst, debit: 0, credit: split.igst, description: `Invoice ${input.invoiceNumber} IGST` });

    return this.persistJournalEntry(
      {
        orgId: input.orgId,
        entryDate: input.invoiceDate,
        description: `Invoice ${input.invoiceNumber} sent`,
        sourceType: INVOICE_SOURCE_TYPE,
        sourceId: String(input.invoiceId),
        sourceEvent: INVOICE_SEND_SOURCE_EVENT,
        createdBy: input.createdBy,
        lines,
      },
      tx,
    );
  }

  postPaymentReceipt(input: PostPaymentInput, tx?: DbOrTx): Promise<PersistedEntry> {
    const cashCode = paymentMethodToAccountCode(input.paymentMethod);
    const lines: DraftLine[] = [
      { accountCode: cashCode, debit: input.amount, credit: 0, description: `Payment for ${input.invoiceNumber} (${input.paymentMethod})` },
      { accountCode: ACCOUNT_CODES.accountsReceivable, debit: 0, credit: input.amount, description: `Payment for ${input.invoiceNumber}` },
    ];

    return this.persistJournalEntry(
      {
        orgId: input.orgId,
        entryDate: input.paymentDate,
        description: `Payment received for ${input.invoiceNumber}`,
        sourceType: "payment",
        sourceId: String(input.paymentId),
        sourceEvent: "receipt",
        createdBy: input.createdBy,
        lines,
      },
      tx,
    );
  }

  postPurchaseBill(input: PostPurchaseBillInput, tx?: DbOrTx): Promise<PersistedEntry> {
    const split = splitTaxPool(input.taxPool, {
      supplierStateCode: input.supplierStateCode,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode,
    });

    const expenseAmount = Math.max(0, input.subtotal - input.discount);
    const lines: DraftLine[] = [
      { accountCode: input.expenseAccountCode, debit: expenseAmount, credit: 0, description: `Bill ${input.billNumber}` },
      { accountCode: ACCOUNTS_PAYABLE, debit: 0, credit: input.total, description: `Bill ${input.billNumber}` },
    ];
    if (split.cgst > 0) lines.push({ accountCode: INPUT_CGST, debit: split.cgst, credit: 0, description: `Bill ${input.billNumber} CGST` });
    if (split.sgst > 0) lines.push({ accountCode: INPUT_SGST, debit: split.sgst, credit: 0, description: `Bill ${input.billNumber} SGST` });
    if (split.igst > 0) lines.push({ accountCode: INPUT_IGST, debit: split.igst, credit: 0, description: `Bill ${input.billNumber} IGST` });

    return this.persistJournalEntry(
      {
        orgId: input.orgId,
        entryDate: input.billDate,
        description: `Purchase bill ${input.billNumber} posted`,
        sourceType: "purchase_bill",
        sourceId: String(input.billId),
        sourceEvent: "post",
        createdBy: input.createdBy,
        lines,
      },
      tx,
    );
  }

  postVendorPayment(input: PostVendorPaymentInput, tx?: DbOrTx): Promise<PersistedEntry> {
    const cashCode = paymentMethodToAccountCode(input.paymentMethod);
    const lines: DraftLine[] = [
      { accountCode: ACCOUNTS_PAYABLE, debit: input.amount, credit: 0, description: `Payment to vendor for ${input.billNumber}` },
      { accountCode: cashCode, debit: 0, credit: input.amount, description: `Payment to vendor for ${input.billNumber} (${input.paymentMethod})` },
    ];

    return this.persistJournalEntry(
      {
        orgId: input.orgId,
        entryDate: input.paymentDate,
        description: `Payment to vendor for ${input.billNumber}`,
        sourceType: "vendor_payment",
        sourceId: String(input.paymentId),
        sourceEvent: "payment",
        createdBy: input.createdBy,
        lines,
      },
      tx,
    );
  }
}
