import { ACCOUNT_CODES, paymentMethodToAccountCode, splitTaxPool } from "../core/posting-rules";
import {
  type DraftEntry,
  type DraftLine,
  type PostInvoiceInput,
  type PostPaymentInput,
  type PostPurchaseBillInput,
  type PostVendorPaymentInput,
  ACCOUNTS_PAYABLE,
  INPUT_CGST,
  INPUT_SGST,
  INPUT_IGST,
  INVOICE_SOURCE_TYPE,
  INVOICE_SEND_SOURCE_EVENT,
} from "./journal-posting.data";

/**
 * The double-entry recipes: which accounts a business document debits and
 * credits, and how its tax pool splits.
 *
 * These are pure — no database, no transaction, no entry number — so the
 * accounting policy can be read and checked on its own. `JournalPostingService`
 * owns the other half: allocating an entry number, asserting the draft balances
 * and persisting it idempotently. The two change for different reasons; a new
 * document type adds a recipe here, a change to numbering or idempotency touches
 * only the service.
 */

export function invoiceSendDraft(input: PostInvoiceInput): DraftEntry {
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

  return {
    orgId: input.orgId,
    entryDate: input.invoiceDate,
    description: `Invoice ${input.invoiceNumber} sent`,
    sourceType: INVOICE_SOURCE_TYPE,
    sourceId: String(input.invoiceId),
    sourceEvent: INVOICE_SEND_SOURCE_EVENT,
    createdBy: input.createdBy,
    lines,
  };
}

export function paymentReceiptDraft(input: PostPaymentInput): DraftEntry {
  const cashCode = paymentMethodToAccountCode(input.paymentMethod);
  const lines: DraftLine[] = [
    { accountCode: cashCode, debit: input.amount, credit: 0, description: `Payment for ${input.invoiceNumber} (${input.paymentMethod})` },
    { accountCode: ACCOUNT_CODES.accountsReceivable, debit: 0, credit: input.amount, description: `Payment for ${input.invoiceNumber}` },
  ];

  return {
    orgId: input.orgId,
    entryDate: input.paymentDate,
    description: `Payment received for ${input.invoiceNumber}`,
    sourceType: "payment",
    sourceId: String(input.paymentId),
    sourceEvent: "receipt",
    createdBy: input.createdBy,
    lines,
  };
}

export function purchaseBillDraft(input: PostPurchaseBillInput): DraftEntry {
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

  return {
    orgId: input.orgId,
    entryDate: input.billDate,
    description: `Purchase bill ${input.billNumber} posted`,
    sourceType: "purchase_bill",
    sourceId: String(input.billId),
    sourceEvent: "post",
    createdBy: input.createdBy,
    lines,
  };
}

export function vendorPaymentDraft(input: PostVendorPaymentInput): DraftEntry {
  const cashCode = paymentMethodToAccountCode(input.paymentMethod);
  const lines: DraftLine[] = [
    { accountCode: ACCOUNTS_PAYABLE, debit: input.amount, credit: 0, description: `Payment to vendor for ${input.billNumber}` },
    { accountCode: cashCode, debit: 0, credit: input.amount, description: `Payment to vendor for ${input.billNumber} (${input.paymentMethod})` },
  ];

  return {
    orgId: input.orgId,
    entryDate: input.paymentDate,
    description: `Payment to vendor for ${input.billNumber}`,
    sourceType: "vendor_payment",
    sourceId: String(input.paymentId),
    sourceEvent: "payment",
    createdBy: input.createdBy,
    lines,
  };
}
