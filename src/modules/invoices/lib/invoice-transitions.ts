export type InvoiceStatus =
  | "DRAFT"
  | "ISSUED"
  | "SENT"
  | "PARTIALLY_PAID"
  | "OVERDUE"
  | "PAID"
  | "FAILED"
  | "VOIDED";

export type InvoicePatchStatus = Extract<
  InvoiceStatus,
  "ISSUED" | "PAID" | "FAILED"
>;

const SETTLEABLE: readonly InvoiceStatus[] = [
  "ISSUED",
  "SENT",
  "PARTIALLY_PAID",
  "OVERDUE",
];

export const INVOICE_PATCH_TRANSITIONS: Record<
  InvoicePatchStatus,
  readonly InvoiceStatus[]
> = {
  ISSUED: ["DRAFT"],
  PAID: SETTLEABLE,
  FAILED: SETTLEABLE,
};

export function canPatchInvoiceStatus(
  from: string,
  to: InvoicePatchStatus,
): boolean {
  return (INVOICE_PATCH_TRANSITIONS[to] as readonly string[]).includes(from);
}
