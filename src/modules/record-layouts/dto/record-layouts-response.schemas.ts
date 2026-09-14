import { z } from "zod";

const recordLayoutGroupSchema = z.object({
  title: z.string(),
  fields: z.array(z.string()),
});

const storedLayoutAdjustmentSchema = z.object({
  layoutKey: z.string(),
  order: z.array(z.string()),
  hidden: z.array(z.string()),
  groups: z.array(recordLayoutGroupSchema),
  updatedAt: z.string(),
});

export const layoutGetSchema = storedLayoutAdjustmentSchema.nullable();

export const layoutSaveSchema = storedLayoutAdjustmentSchema;

export const layoutResetSchema = z.null();

export const layoutUsageSchema = z.object({
  sample: z.number().int(),
  cap: z.number().int(),
  filled: z.record(z.string(), z.number().int()),
  uncounted: z.array(z.string()),
});
