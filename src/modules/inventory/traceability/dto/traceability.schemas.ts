import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listLotsSchema = z.object({
  variantId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  status: z.enum(["ACTIVE", "EXPIRED", "BLOCKED", "CONSUMED", "RECALLED"]).optional(),
  expiringWithinDays: z.coerce.number().int().min(1).optional(),
  search: z.string().optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ListLotsInput = z.infer<typeof listLotsSchema>;

export const listSerialsSchema = z.object({
  variantId: z.coerce.number().int().positive().optional(),
  status: z.enum(["IN_STOCK", "RESERVED", "SHIPPED", "RETURNED", "SCRAPPED", "QUARANTINE"]).optional(),
  search: z.string().optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ListSerialsInput = z.infer<typeof listSerialsSchema>;

export const expiryQuerySchema = z.object({
  withinDays: z.coerce.number().int().min(1).default(30),
}).strict();
export type ExpiryQueryInput = z.infer<typeof expiryQuerySchema>;

export const updateLotStatusSchema = z.object({
  status: z.enum(["ACTIVE", "BLOCKED"]),
}).strict();
export type UpdateLotStatusInput = z.infer<typeof updateLotStatusSchema>;

export const traceabilityQuerySchema = z
  .object({
    lotId: z.coerce.number().int().positive().optional(),
    serialId: z.coerce.number().int().positive().optional(),
  }).strict()
  .refine((d) => d.lotId != null || d.serialId != null, {
    message: "lotId or serialId is required",
  });
export type TraceabilityQueryInput = z.infer<typeof traceabilityQuerySchema>;
