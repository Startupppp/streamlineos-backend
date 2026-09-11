import { z } from "zod";

export const apAgingQuerySchema = z
  .object({
    bookId: z.string().min(1).optional(),
    /** Defaults to today. Aging is always "as of" a date, never "now". */
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").optional(),
    partyId: z.string().min(1).optional(),
    /** Include the document-level rows under each vendor. */
    includeItems: z.coerce.boolean().default(true),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ApAgingQuery = z.infer<typeof apAgingQuerySchema>;
