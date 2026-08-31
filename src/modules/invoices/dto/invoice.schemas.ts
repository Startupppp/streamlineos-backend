import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const listInvoicesSchema = z.object({
  status: z.enum(["DRAFT", "ISSUED", "PAID", "FAILED", "VOIDED"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  page: pageNumberField,
  limit: pageSizeField(50),
});

export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;
