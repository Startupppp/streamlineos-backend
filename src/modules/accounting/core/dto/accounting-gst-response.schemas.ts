import { z } from "zod";

const taxBlockSchema = z.object({
  taxableValue: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
});

const gstr1RateBucketSchema = z.object({
  gstRate: z.string(),
  taxableValue: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
  invoiceCount: z.number().int(),
});

const gstr1PlaceBucketSchema = z.object({
  placeOfSupply: z.string().nullable(),
  placeName: z.string().nullable(),
  rates: z.array(gstr1RateBucketSchema),
});

const gstr1SectionSchema = z.object({
  section: z.enum(["B2B", "B2C"]),
  places: z.array(gstr1PlaceBucketSchema),
  totalTaxableValue: z.string(),
  totalCgst: z.string(),
  totalSgst: z.string(),
  totalIgst: z.string(),
  totalInvoices: z.number().int(),
});

export const gstr1ResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  b2b: gstr1SectionSchema,
  b2c: gstr1SectionSchema,
  grandTotal: z.object({
    taxableValue: z.string(),
    cgst: z.string(),
    sgst: z.string(),
    igst: z.string(),
    invoices: z.number().int(),
  }),
});

const gstr3bItcSectionSchema = z.object({
  available: taxBlockSchema,
  reversed: taxBlockSchema,
  net: taxBlockSchema,
});

export const gstr3bResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  outward: z.object({
    taxable: taxBlockSchema,
    zeroRated: taxBlockSchema,
    nilExempted: taxBlockSchema,
    reverseCharge: taxBlockSchema,
  }),
  itc: gstr3bItcSectionSchema,
  netTaxPayable: z.object({
    cgst: z.string(),
    sgst: z.string(),
    igst: z.string(),
    total: z.string(),
  }),
  invoiceCount: z.number().int(),
  billCount: z.number().int(),
});
