import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listTaxPaymentsQuerySchema = z.object({
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
  taxType: z.enum(["GST", "CGST_SGST", "IGST", "VAT", "TDS", "TCS", "EXEMPT", "ZERO_RATED"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const createTaxPaymentSchema = z.object({
  taxType: z.enum(["GST", "CGST_SGST", "IGST", "VAT", "TDS", "TCS", "EXEMPT", "ZERO_RATED"]),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().min(1).max(200),
  notes: z.string().max(1000).optional(),
});

export type ListTaxPaymentsQuery = z.infer<typeof listTaxPaymentsQuerySchema>;
export type CreateTaxPaymentInput = z.infer<typeof createTaxPaymentSchema>;
