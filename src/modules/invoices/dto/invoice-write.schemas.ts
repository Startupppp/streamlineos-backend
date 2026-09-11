import { z } from "zod";

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const legacyLineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().min(1).max(999999),
  rate: z.number().positive().max(999999999.99),
  amount: z.number().min(0).max(999999999.99),
});

const itemSchema = z.object({
  description: z.string().min(1),
  hsnSacCode: z.string().optional(),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  gstRate: z.number().refine((v) => [0, 5, 12, 18, 28].includes(v), { message: "gstRate must be 0/5/12/18/28" }),
});

function computeGrossTotal(input: {
  items?: { quantity: number; rate: number; gstRate: number }[];
  lineItems?: { amount: number }[];
}): number {
  if (input.items?.length) {
    return input.items.reduce((acc, it) => {
      const amount = it.quantity * it.rate;
      return acc + amount + amount * (it.gstRate / 100);
    }, 0);
  }
  return (input.lineItems ?? []).reduce((acc, li) => acc + li.amount, 0);
}

export const createInvoiceSchema = z
  .object({
    clientId: z.number().optional(),
    projectId: z.number().optional(),
    lineItems: z.array(legacyLineItemSchema).min(1).optional(),
    items: z.array(itemSchema).min(1).optional(),
    taxRate: z.number().min(0).max(100).default(0),
    discount: z.number().min(0).default(0),
    currency: z.string().default("INR"),
    dueDate: z.string().optional(),
    notes: z.string().optional(),
    status: z.enum(["DRAFT", "ISSUED"]).default("DRAFT"),
    placeOfSupply: z.string().regex(/^\d{2}$/).optional(),
    customerGstin: z.string().regex(GSTIN_REGEX).optional(),
    supplierGstin: z.string().regex(GSTIN_REGEX).optional(),
    reverseCharge: z.boolean().optional(),
    taxInclusive: z.boolean().optional(),
  }).strict()
  .refine((v) => Boolean(v.items?.length || v.lineItems?.length), {
    message: "Either items or lineItems must be provided",
  })
  .refine((v) => v.discount <= computeGrossTotal(v), {
    message: "Discount cannot exceed the invoice subtotal plus tax",
    path: ["discount"],
  });

/**
 * The edit shape. It is the legacy line (which carries a pre-computed `amount`)
 * plus the two fields that make a line a GST tax-invoice line: its rate and its
 * HSN/SAC code. Both are optional so existing callers keep working — when they
 * are absent the service carries the stored values forward rather than writing
 * zeros over them, and refuses the edit outright when carrying them forward
 * would be a guess. See invoices-update.service.ts.
 */
const updateLineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().min(1).max(999999),
  rate: z.number().positive().max(999999999.99),
  amount: z.number().min(0).max(999999999.99),
  gstRate: z
    .number()
    .refine((v) => [0, 5, 12, 18, 28].includes(v), { message: "gstRate must be 0/5/12/18/28" })
    .optional(),
  hsnSacCode: z.string().optional(),
});

export const updateInvoiceSchema = z.object({
  clientId: z.number().optional(),
  projectId: z.number().optional(),
  lineItems: z.array(updateLineItemSchema).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  discount: z.number().min(0).optional(),
  currency: z.string().optional(),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(["ISSUED", "PAID", "FAILED"]).optional(),
}).strict();

export const recordPaymentSchema = z.object({
  amount: z.number().positive().max(999999999.99),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  paymentMethod: z.enum(["bank_transfer", "upi", "cheque", "cash", "card", "other"]),
  referenceNumber: z.string().optional(),
  notes: z.string().optional(),
  allocations: z
    .array(
      z.object({
        invoiceId: z.number().int().positive(),
        amount: z.number().positive(),
      }),
    )
    .optional(),
}).strict();

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
