import { z } from "zod";

export const pageIdParams = z
  .object({ pageId: z.coerce.number().int().positive() })
  .strict();

export const briefIdParams = z
  .object({ briefId: z.coerce.number().int().positive() })
  .strict();

export const pageIdversionNumberParams = z
  .object({
    pageId: z.coerce.number().int().positive(),
    versionNumber: z.coerce.number().int().positive(),
  })
  .strict();
