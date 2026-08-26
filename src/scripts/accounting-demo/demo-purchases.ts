/**
 * The quarter's purchases: two vendor bills and one payment that withholds tax.
 *
 * The consulting bill is deliberately over the 194J threshold and zero-rated —
 * India withholds on the professional fee, not on the GST charged over it, so a
 * demo that stayed under the limit would show a TDS feature deducting nothing.
 */
import { apDocuments, apPayments } from "../../db/schema";
import { CODE, accountIdFor, findByReference, requireParty, type Context } from "./demo-context";

interface BillSeed {
  reference: string;
  partyKey: string;
  issueDate: string;
  vendorDocumentNumber: string;
  description: string;
  unitPriceMinor: number;
  taxCategory: "standard" | "zero";
}

const BILLS: readonly BillSeed[] = [
  {
    reference: "SEED-BILL-1",
    partyKey: "vendor-supplies",
    issueDate: "2026-04-15",
    vendorDocumentNumber: "KOS/26/0412",
    description: "Workstations and stationery",
    unitPriceMinor: 800_000,
    taxCategory: "standard",
  },
  {
    reference: "SEED-BILL-2",
    partyKey: "vendor-consulting",
    issueDate: "2026-05-18",
    vendorDocumentNumber: "MC-2026-118",
    description: "Professional fees — May",
    unitPriceMinor: 20_000_000,
    taxCategory: "zero",
  },
];

export async function seedBills(
  ctx: Context,
  parties: Map<string, string>,
): Promise<Map<string, string>> {
  const byReference = new Map<string, string>();

  for (const seed of BILLS) {
    const existing = await findByReference(ctx, apDocuments, seed.reference);
    if (existing) {
      byReference.set(seed.reference, existing.id);
      if (existing.status === "DRAFT") await ctx.bills.post(ctx.orgId, ctx.userId, existing.id);
      continue;
    }

    const draft = await ctx.bills.create(ctx.orgId, ctx.userId, {
      documentType: "BILL",
      partyId: requireParty(parties, seed.partyKey),
      issueDate: seed.issueDate,
      vendorDocumentNumber: seed.vendorDocumentNumber,
      vendorDocumentDate: seed.issueDate,
      reference: seed.reference,
      blockedInputTax: false,
      taxInclusive: false,
      lines: [
        {
          description: seed.description,
          quantityMilli: 1000,
          unitPriceMinor: seed.unitPriceMinor,
          discountMinor: 0,
          taxCategory: seed.taxCategory,
          capitalize: false,
        },
      ],
    });
    await ctx.bills.post(ctx.orgId, ctx.userId, draft.id);
    byReference.set(seed.reference, draft.id);
  }

  return byReference;
}

const PAYMENT = {
  reference: "SEED-PAY-1",
  partyKey: "vendor-consulting",
  billReference: "SEED-BILL-2",
  paymentDate: "2026-06-05",
  amountMinor: 20_000_000,
} as const;

export async function seedPaymentWithTds(
  ctx: Context,
  parties: Map<string, string>,
  bills: Map<string, string>,
): Promise<string> {
  const existing = await findByReference(ctx, apPayments, PAYMENT.reference);
  if (existing) return existing.id;

  const billId = bills.get(PAYMENT.billReference);
  if (!billId) throw new Error("The consulting bill was not seeded, so it cannot be paid");

  const { payment } = await ctx.payments.postPayment(ctx.orgId, ctx.userId, {
    partyId: requireParty(parties, PAYMENT.partyKey),
    paymentDate: PAYMENT.paymentDate,
    paymentAccountId: await accountIdFor(ctx, CODE.bank),
    paymentMethod: "NEFT",
    reference: PAYMENT.reference,
    // The vendor carries 194J, so the engine works the deduction out itself.
    withholding: { mode: "auto" },
    allocations: [{ documentId: billId, amountMinor: PAYMENT.amountMinor }],
  });
  return payment.id;
}
