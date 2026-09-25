import { z } from "zod";

export const exportPageSchema = z.object({
  format: z.enum(["markdown", "html"]),
}).strict();
export type ExportPageInput = z.infer<typeof exportPageSchema>;

export const importItemSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    contentText: z.string().max(50000).optional(),
    parentPageId: z.coerce.number().int().positive().optional(),
    externalId: z.string().min(1).max(500).optional(),
    externalSource: z.string().min(1).max(100).optional(),
  })
  .refine(
    (item) => (item.externalId === undefined) === (item.externalSource === undefined),
    {
      message:
        "externalId and externalSource must be supplied together: a unique index cannot match on a null source, so a half-populated reference re-imports as a duplicate",
      path: ["externalSource"],
    },
  );

export const importPagesSchema = z.object({
  sourceType: z.enum(["markdown", "html", "zip"]),
  items: z.array(importItemSchema).min(1).max(100),
  spaceId: z.coerce.number().int().positive().optional(),
  visibility: z.enum(["private", "org", "public"]).default("org"),
  duplicatePolicy: z.enum(["skip", "update"]).default("skip"),
}).strict();
export type ImportPagesInput = z.infer<typeof importPagesSchema>;
