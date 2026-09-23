import { eq, sql } from "drizzle-orm";
import { invoices, invoiceItems } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

export type InvoiceRow = typeof invoices.$inferSelect;

export interface InvoiceLineToInsert {
  description: string;
  hsnSacCode?: string | undefined;
  quantity: number;
  rate: number;
  gstRate: number;
  amount: number;
  lineOrder: number;
  timesheetEntryId?: number | undefined;
}

export interface InvoiceHeaderToInsert {
  clientId?: number | undefined;
  projectId?: number | undefined;
  status: "DRAFT" | "ISSUED";
  subtotal: number;
  taxPool: number;
  discount: number;
  total: number;
  currency: string;
  dueDate?: string | undefined;
  notes?: string | undefined;
  placeOfSupply: string;
  customerGstin?: string | undefined;
  supplierGstin?: string | undefined;
  reverseCharge?: boolean | undefined;
  taxInclusive?: boolean | undefined;
  split: { cgst: number; sgst: number; igst: number };
}

export async function insertInvoiceWithItems(
  tx: TenantTx,
  orgId: string,
  userId: string,
  header: InvoiceHeaderToInsert,
  lines: ReadonlyArray<InvoiceLineToInsert>,
): Promise<InvoiceRow> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${orgId} || 'invoice'))`,
  );

  const countRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.orgId, orgId));
  const nextNum = (countRows[0]?.count ?? 0) + 1;
  const invoiceNumber = `INV-${new Date().getFullYear()}-${String(nextNum).padStart(4, "0")}`;

  const [inserted] = await tx
    .insert(invoices)
    .values({
      orgId,
      clientId: header.clientId,
      projectId: header.projectId,
      invoiceNumber,
      status: header.status,
      subtotal: header.subtotal.toFixed(2),
      taxRate: "0",
      taxAmount: header.taxPool.toFixed(2),
      discount: header.discount.toFixed(2),
      total: header.total.toFixed(2),
      currency: header.currency,
      dueDate: header.dueDate,
      notes: header.notes,
      placeOfSupply: header.placeOfSupply || null,
      customerGstin: header.customerGstin ?? null,
      supplierGstin: header.supplierGstin ?? null,
      reverseCharge: header.reverseCharge ?? false,
      taxInclusive: header.taxInclusive ?? false,
      cgstAmount: header.split.cgst.toFixed(4),
      sgstAmount: header.split.sgst.toFixed(4),
      igstAmount: header.split.igst.toFixed(4),
      sentAt: header.status === "ISSUED" ? new Date() : undefined,
      createdBy: userId,
    })
    .returning();

  if (!inserted) throw new Error("Invoice insert returned no rows");

  if (lines.length > 0) {
    await tx.insert(invoiceItems).values(
      lines.map((it) => ({
        invoiceId: inserted.id,
        description: it.description,
        hsnSacCode: it.hsnSacCode ?? null,
        quantity: it.quantity.toFixed(4),
        rate: it.rate.toFixed(4),
        gstRate: it.gstRate.toFixed(2),
        amount: it.amount.toFixed(4),
        lineOrder: it.lineOrder,
        timesheetEntryId: it.timesheetEntryId ?? null,
      })),
    );
  }

  return inserted;
}
