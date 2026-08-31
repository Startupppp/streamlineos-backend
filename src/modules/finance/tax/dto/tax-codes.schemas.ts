import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const listTaxCodesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
  taxType: z
    .enum([
      "GST",
      "CGST_SGST",
      "IGST",
      "VAT",
      "TDS",
      "TCS",
      "EXEMPT",
      "ZERO_RATED",
    ])
    .optional(),
  isActive: queryBoolean.optional(),
});

export const createTaxCodeSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50),
  rate: z.string().regex(/^\d+(\.\d{1,2})?$/),
  taxType: z.enum([
    "GST",
    "CGST_SGST",
    "IGST",
    "VAT",
    "TDS",
    "TCS",
    "EXEMPT",
    "ZERO_RATED",
  ]),
  isReverseCharge: z.boolean().default(false),
  collectedAccountId: z.number().int().positive().optional(),
  paidAccountId: z.number().int().positive().optional(),
  isActive: z.boolean().default(true),
});

export const updateTaxCodeSchema = createTaxCodeSchema.partial();

export type ListTaxCodesQuery = z.infer<typeof listTaxCodesQuerySchema>;
export type CreateTaxCodeInput = z.infer<typeof createTaxCodeSchema>;
export type UpdateTaxCodeInput = z.infer<typeof updateTaxCodeSchema>;
