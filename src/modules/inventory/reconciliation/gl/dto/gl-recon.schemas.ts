import { z } from "zod";
import { GL_RECON_STATUSES } from "../gl-posting-rules";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The window is a closed range or an accounting period; a period supplies both
 * ends. Without either the service defaults to the current calendar month, so
 * the report is never an unbounded scan of the ledger.
 */
export const glReconQuerySchema = z
  .object({
    /** `gl_periods.id` of the organisation's default book — a uuid since the accounting rewrite. */
    periodId: z.string().uuid().optional(),
    fromDate: isoDate.optional(),
    toDate: isoDate.optional(),
    warehouseId: z.coerce.number().int().positive().optional(),
    status: z.enum(GL_RECON_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type GlReconQueryInput = z.infer<typeof glReconQuerySchema>;
