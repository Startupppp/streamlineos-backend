import { z } from "zod";

export const listCountsSchema = z.object({
  status: z.enum(["PLANNED", "COUNTING", "REVIEW", "POSTED", "CANCELLED"]).optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListCountsInput = z.infer<typeof listCountsSchema>;

export const createCycleCountSchema = z.object({
  warehouseId: z.number().int().positive(),
  locationId: z.number().int().positive().optional(),
  categoryId: z.number().int().positive().optional(),
  notes: z.string().max(500).optional(),
}).strict();
export type CreateCycleCountInput = z.infer<typeof createCycleCountSchema>;

export const updateCountLinesSchema = z.object({
  lines: z.array(z.object({
    lineId: z.number().int().positive(),
    countedQty: z.number().min(0),
  }).strict()).min(1),
}).strict();
export type UpdateCountLinesInput = z.infer<typeof updateCountLinesSchema>;

export const createAuditSchema = z.object({
  warehouseId: z.number().int().positive(),
  notes: z.string().max(500).optional(),
}).strict();
export type CreateAuditInput = z.infer<typeof createAuditSchema>;
