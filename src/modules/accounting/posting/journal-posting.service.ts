import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ACCOUNT_CODES, type GstSplit, paymentMethodToAccountCode, splitTaxPool } from "../core/posting-rules";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DraftLine {
  accountCode: string;
  debit: number;
  credit: number;
  description?: string | null;
}

export interface DraftEntry {
  orgId: string;
  entryDate: string;
  description?: string | null;
  sourceType: string;
  sourceId: string | null;
  sourceEvent: string | null;
  status?: "DRAFT" | "POSTED";
  createdBy: string;
  lines: DraftLine[];
}

export interface PersistedEntry {
  id: number;
  entryNumber: string;
}

export interface PostInvoiceInput {
  orgId: string;
  invoiceId: number;
  invoiceNumber: string;
  invoiceDate: string;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  subtotal: number;
  discount: number;
  taxPool: number;
  total: number;
  createdBy: string;
}

export interface PostPaymentInput {
  orgId: string;
  paymentId: number;
  invoiceNumber: string;
  paymentDate: string;
  paymentMethod: string;
  amount: number;
  createdBy: string;
}

export interface PostPurchaseBillInput {
  orgId: string;
  billId: number;
  billNumber: string;
  billDate: string;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  subtotal: number;
  discount: number;
  taxPool: number;
  total: number;
  expenseAccountCode: string;
  createdBy: string;
}

export interface PostVendorPaymentInput {
  orgId: string;
  paymentId: number;
  billNumber: string;
  paymentDate: string;
  paymentMethod: string;
  amount: number;
  createdBy: string;
}

interface SeedAccount {
  code: string;
  name: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
}

const ACCOUNTS_PAYABLE = "2000";
const INPUT_CGST = "1410";
const INPUT_SGST = "1411";
const INPUT_IGST = "1412";

const DEFAULT_COA: ReadonlyArray<SeedAccount> = [
  { code: "1000", name: "Cash", accountType: "ASSET" },
  { code: "1100", name: "Bank Account", accountType: "ASSET" },
  { code: "1200", name: "Accounts Receivable", accountType: "ASSET" },
  { code: "1300", name: "Inventory", accountType: "ASSET" },
  { code: "1400", name: "Prepaid Expenses", accountType: "ASSET" },
  { code: "1410", name: "Input CGST", accountType: "ASSET" },
  { code: "1411", name: "Input SGST", accountType: "ASSET" },
  { code: "1412", name: "Input IGST", accountType: "ASSET" },
  { code: "1500", name: "Fixed Assets", accountType: "ASSET" },
  { code: "1510", name: "Office Equipment", accountType: "ASSET" },
  { code: "1520", name: "Furniture and Fixtures", accountType: "ASSET" },
  { code: "1530", name: "Vehicles", accountType: "ASSET" },
  { code: "1590", name: "Accumulated Depreciation", accountType: "ASSET" },
  { code: "1600", name: "Security Deposits", accountType: "ASSET" },
  { code: "2000", name: "Accounts Payable", accountType: "LIABILITY" },
  { code: "2100", name: "GST Payable", accountType: "LIABILITY" },
  { code: "2110", name: "Output CGST", accountType: "LIABILITY" },
  { code: "2111", name: "Output SGST", accountType: "LIABILITY" },
  { code: "2112", name: "Output IGST", accountType: "LIABILITY" },
  { code: "2200", name: "TDS Payable", accountType: "LIABILITY" },
  { code: "2300", name: "Salary Payable", accountType: "LIABILITY" },
  { code: "2400", name: "Bonus Payable", accountType: "LIABILITY" },
  { code: "2500", name: "Provident Fund Payable", accountType: "LIABILITY" },
  { code: "2600", name: "ESI Payable", accountType: "LIABILITY" },
  { code: "2700", name: "Loans Payable", accountType: "LIABILITY" },
  { code: "3000", name: "Owner's Equity", accountType: "EQUITY" },
  { code: "3100", name: "Retained Earnings", accountType: "EQUITY" },
  { code: "3200", name: "Drawings", accountType: "EQUITY" },
  { code: "4000", name: "Sales Revenue", accountType: "INCOME" },
  { code: "4100", name: "Service Revenue", accountType: "INCOME" },
  { code: "4200", name: "Subscription Revenue", accountType: "INCOME" },
  { code: "4300", name: "Interest Income", accountType: "INCOME" },
  { code: "4900", name: "Other Income", accountType: "INCOME" },
  { code: "5000", name: "Cost of Goods Sold", accountType: "EXPENSE" },
  { code: "5100", name: "Salaries Expense", accountType: "EXPENSE" },
  { code: "5110", name: "Bonus Expense", accountType: "EXPENSE" },
  { code: "5120", name: "PF Contribution Expense", accountType: "EXPENSE" },
  { code: "5200", name: "Rent Expense", accountType: "EXPENSE" },
  { code: "5300", name: "Utilities Expense", accountType: "EXPENSE" },
  { code: "5400", name: "Office Supplies", accountType: "EXPENSE" },
  { code: "5500", name: "Travel Expense", accountType: "EXPENSE" },
  { code: "5600", name: "Marketing Expense", accountType: "EXPENSE" },
  { code: "5700", name: "Professional Fees", accountType: "EXPENSE" },
  { code: "5800", name: "Software Subscriptions", accountType: "EXPENSE" },
  { code: "5850", name: "Internet and Communication", accountType: "EXPENSE" },
  { code: "5900", name: "Depreciation Expense", accountType: "EXPENSE" },
  { code: "5910", name: "Bank Charges", accountType: "EXPENSE" },
  { code: "5920", name: "Interest Expense", accountType: "EXPENSE" },
  { code: "5990", name: "Miscellaneous Expense", accountType: "EXPENSE" },
];

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

  private assertBalanced(lines: DraftLine[]): void {
    const totalDebitMinor = lines.reduce((acc, l) => acc + Math.round(l.debit * 100), 0);
    const totalCreditMinor = lines.reduce((acc, l) => acc + Math.round(l.credit * 100), 0);
    if (totalDebitMinor !== totalCreditMinor) {
      throw new Error(
        `Unbalanced journal entry: debit=${totalDebitMinor} credit=${totalCreditMinor} diff=${totalDebitMinor - totalCreditMinor} (minor units)`,
      );
    }
    for (const line of lines) {
      if (line.debit < 0 || line.credit < 0) {
        throw new Error(`Negative amount in journal line: ${JSON.stringify(line)}`);
      }
      if ((line.debit > 0 && line.credit > 0) || (line.debit === 0 && line.credit === 0)) {
        throw new Error(`Journal line must have exactly one of debit or credit > 0: ${JSON.stringify(line)}`);
      }
    }
  }

  async persistJournalEntry(draft: DraftEntry, tx?: DbOrTx): Promise<PersistedEntry> {
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
            debit: line.debit.toFixed(4),
            credit: line.credit.toFixed(4),
            description: line.description ?? null,
            lineOrder: idx,
          };
        });
        await executor.insert(journalLines).values(lineRows);

        return entry;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isUniqueViolation = message.includes("uniq_je_org_number") || message.includes("23505");
        if (!isUniqueViolation || attempt === maxAttempts - 1) throw error;
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
        sourceType: "invoice",
        sourceId: String(input.invoiceId),
        sourceEvent: "send",
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
