import { z } from "zod";

export const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
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
});

export type ListInput = z.infer<typeof listSchema>;
