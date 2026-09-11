import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const listResponsesSchema = z.object({
  collectorId: z.coerce.number().int().positive().optional(),
  status: z.enum(["in_progress", "submitted", "invalid", "excluded", "deleted_by_policy"]).optional(),
  page: pageNumberField,
  pageSize: pageSizeField(25, 100),
}).strict();

export const exportResponsesSchema = z.object({
  format: z.enum(["csv"]).default("csv"),
  collectorId: z.number().int().positive().optional(),
  status: z.enum(["in_progress", "submitted", "invalid", "excluded", "deleted_by_policy"]).optional(),
}).strict();

export type ListResponsesInput = z.infer<typeof listResponsesSchema>;
export type ExportResponsesInput = z.infer<typeof exportResponsesSchema>;
