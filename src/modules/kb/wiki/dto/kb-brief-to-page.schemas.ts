import { z } from "zod";

export const convertBriefToPageSchema = z
  .object({
    spaceId: z.coerce.number().int().positive().nullable().optional(),
    parentPageId: z.coerce.number().int().positive().nullable().optional(),
  })
  .strict();
export type ConvertBriefToPageInput = z.infer<typeof convertBriefToPageSchema>;

export const convertBriefToPageResponseSchema = z
  .object({ pageId: z.number().int().positive() })
  .strict();
