/**
 * The quarter's sales: four invoices at mixed GST treatments — intra-state
 * 18%, inter-state IGST, a zero-rated USD export and a reduced 5% supply — and
 * two customer receipts, one of them only part-settling its invoice.
 */
import { arDocuments, arReceipts } from "../../db/schema";
import { USD_RATE, findByReference, requireParty, type Context } from "./demo-context";

interface InvoiceSeed {
  reference: string;
  partyKey: string;
  issueDate: string;
  description: string;
  unitPriceMinor: number;
  taxCategory?: "standard" | "reduced";
  currency?: string;
  fxRate?: string;
  supplyNature?: "domestic_b2b" | "export";
}

const INVOICES: readonly InvoiceSeed[] = [
  {
    reference: "SEED-INV-1",
    partyKey: "customer-bengaluru",
    issueDate: "2026-04-08",
    description: "Implementation services",
    unitPriceMinor: 5_000_000,
  },
  {
    reference: "SEED-INV-2",
    partyKey: "customer-mumbai",
    issueDate: "2026-04-22",
    description: "Annual platform licence",
    unitPriceMinor: 3_000_000,
  },
  {
    reference: "SEED-INV-3",
    partyKey: "customer-northwind",
    issueDate: "2026-05-06",
    description: "Offshore development retainer",
    unitPriceMinor: 100_000,
    currency: "USD",
    fxRate: USD_RATE,
    supplyNature: "export",
  },
  {
    reference: "SEED-INV-4",
    partyKey: "customer-bengaluru",
    issueDate: "2026-05-20",
    description: "Printed training manuals",
    unitPriceMinor: 400_000,
    taxCategory: "reduced",
  },
];

export async function seedInvoices(
  ctx: Context,
  parties: Map<string, string>,
): Promise<Map<string, string>> {
  const byReference = new Map<string, string>();

  for (const seed of INVOICES) {
    const existing = await findByReference(ctx, arDocuments, seed.reference);
    if (existing) {
      byReference.set(seed.reference, existing.id);
      if (existing.status === "DRAFT") await ctx.invoices.post(ctx.orgId, ctx.userId, existing.id);
      continue;
    }

    const draft = await ctx.invoices.createInvoice(ctx.orgId, ctx.userId, {
      partyId: requireParty(parties, seed.partyKey),
      issueDate: seed.issueDate,
      reference: seed.reference,
      currency: seed.currency,
      fxRate: seed.fxRate,
      supplyNature: seed.supplyNature,
      lines: [
        {
          description: seed.description,
          quantityMilli: 1000,
          unitPriceMinor: seed.unitPriceMinor,
          taxCategory: seed.taxCategory ?? "standard",
          commodityCode: "998313",
        },
      ],
    });
    await ctx.invoices.post(ctx.orgId, ctx.userId, draft.id);
    byReference.set(seed.reference, draft.id);
  }

  return byReference;
}

interface ReceiptSeed {
  reference: string;
  partyKey: string;
  invoiceReference: string;
  receiptDate: string;
  amountMinor: number;
  paymentMethod: string;
}

const RECEIPTS: readonly ReceiptSeed[] = [
  {
    reference: "SEED-RCP-1",
    partyKey: "customer-bengaluru",
    invoiceReference: "SEED-INV-1",
    receiptDate: "2026-05-12",
    amountMinor: 3_000_000,
    paymentMethod: "NEFT",
  },
  {
    reference: "SEED-RCP-2",
    partyKey: "customer-mumbai",
    invoiceReference: "SEED-INV-2",
    receiptDate: "2026-06-10",
    amountMinor: 3_540_000,
    paymentMethod: "RTGS",
  },
];

export async function seedReceipts(
  ctx: Context,
  parties: Map<string, string>,
  invoices: Map<string, string>,
): Promise<string[]> {
  const ids: string[] = [];

  for (const seed of RECEIPTS) {
    const existing = await findByReference(ctx, arReceipts, seed.reference);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const invoiceId = invoices.get(seed.invoiceReference);
    if (!invoiceId) throw new Error(`Receipt ${seed.reference} has no invoice to settle`);

    const { receipt } = await ctx.receipts.postReceipt(ctx.orgId, ctx.userId, {
      partyId: requireParty(parties, seed.partyKey),
      receiptDate: seed.receiptDate,
      depositAccountTag: "bank",
      amountMinor: seed.amountMinor,
      paymentMethod: seed.paymentMethod,
      reference: seed.reference,
      allocations: [{ documentId: invoiceId, amountMinor: seed.amountMinor }],
    });
    ids.push(receipt.id);
  }

  return ids;
}
