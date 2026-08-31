import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const listSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(25, 100),
  action: z.string().min(1).max(200).optional(),
  actions: z
    .string()
    .min(1)
    .max(500)
    .transform((value) => value.split(",").map((action) => action.trim()).filter(Boolean))
    .refine((actions) => actions.length <= 20)
    .optional(),
  targetType: z.string().min(1).max(200).optional(),
  dateFrom: z.string().min(1).optional(),
  dateTo: z.string().min(1).optional(),
  userSearch: z.string().min(1).max(200).optional(),
});

export type ListInput = z.infer<typeof listSchema>;

export const exportSchema = listSchema.omit({ cursor: true, limit: true });
export type ExportInput = z.infer<typeof exportSchema>;
