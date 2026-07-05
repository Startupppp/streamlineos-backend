import { z } from "zod";

export const listResponsesSchema = z.object({
  collectorId: z.coerce.number().int().positive().optional(),
  status: z.enum(["in_progress", "submitted", "invalid", "excluded", "deleted_by_policy"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const exportResponsesSchema = z.object({
  format: z.enum(["csv"]).default("csv"),
  collectorId: z.number().int().positive().optional(),
  status: z.enum(["in_progress", "submitted", "invalid", "excluded", "deleted_by_policy"]).optional(),
});

export type ListResponsesInput = z.infer<typeof listResponsesSchema>;
export type ExportResponsesInput = z.infer<typeof exportResponsesSchema>;
