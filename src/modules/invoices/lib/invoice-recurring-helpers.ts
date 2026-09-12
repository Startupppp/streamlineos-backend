import { asc, eq } from "drizzle-orm";
import { invoices, invoiceItems } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { normalizeGstRate } from "./invoice-helpers";
import type { CreateInvoiceInput } from "../dto/invoice-write.schemas";

export async function buildCloneInput(db: Db, sourceId: number): Promise<CreateInvoiceInput> {
  const source = await db.query.invoices.findFirst({
    where: eq(invoices.id, sourceId),
    with: { items: { orderBy: [asc(invoiceItems.lineOrder)] } },
  });
  if (!source) throw new Error(`Recurring source invoice ${sourceId} not found`);

  const items = source.items.map((item) => ({
    description: item.description,
    hsnSacCode: item.hsnSacCode ?? undefined,
    quantity: Number(item.quantity),
    rate: Number(item.rate),
    gstRate: normalizeGstRate(item.gstRate),
  }));

  return {
    clientId: source.clientId ?? undefined,
    projectId: source.projectId ?? undefined,
    items: items.length > 0 ? items : undefined,
    taxRate: 0,
    discount: Number(source.discount ?? "0"),
    currency: source.currency,
    notes: source.notes ?? undefined,
    status: "DRAFT",
    placeOfSupply: source.placeOfSupply ?? undefined,
    customerGstin: source.customerGstin ?? undefined,
    supplierGstin: source.supplierGstin ?? undefined,
    reverseCharge: source.reverseCharge,
    taxInclusive: source.taxInclusive,
  };
}
