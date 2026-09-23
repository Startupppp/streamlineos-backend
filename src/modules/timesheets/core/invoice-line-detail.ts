import { invoiceLineDetailEnum } from "../../../db/schema";

export type InvoiceLineDetail = (typeof invoiceLineDetailEnum.enumValues)[number];

export const SAFE_INVOICE_LINE_DETAIL: InvoiceLineDetail = "summary";

export const INVOICE_LINE_DETAIL_VALUES = invoiceLineDetailEnum.enumValues;

export function safestInvoiceLineDetail(
  values: readonly InvoiceLineDetail[],
): InvoiceLineDetail {
  if (values.length === 0) return SAFE_INVOICE_LINE_DETAIL;
  return values.every((value) => value === "raw")
    ? "raw"
    : SAFE_INVOICE_LINE_DETAIL;
}
