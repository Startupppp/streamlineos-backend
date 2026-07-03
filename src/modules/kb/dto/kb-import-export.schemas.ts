import { z } from "zod";

export const exportPageSchema = z.object({
  format: z.enum(["markdown", "html"]),
});
export type ExportPageInput = z.infer<typeof exportPageSchema>;

export const importItemSchema = z.object({
  title: z.string().trim().min(1).max(500),
  contentText: z.string().max(50000).optional(),
  parentPageId: z.coerce.number().int().positive().optional(),
});

export const importPagesSchema = z.object({
  sourceType: z.enum(["markdown", "html", "zip"]),
  items: z.array(importItemSchema).min(1).max(100),
});
export type ImportPagesInput = z.infer<typeof importPagesSchema>;
