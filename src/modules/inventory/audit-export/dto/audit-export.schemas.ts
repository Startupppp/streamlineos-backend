import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const createAuditExportJobSchema = z
  .object({
    /** Inclusive lower bound on `created_at`, the immutable ledger timestamp. */
    from: isoDate.optional(),
    /** Inclusive upper bound, resolved to the end of that day. */
    to: isoDate.optional(),
  })
  .strict()
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: "from must not be after to",
    path: ["from"],
  });
export type CreateAuditExportJobInput = z.infer<typeof createAuditExportJobSchema>;

export const listAuditExportJobsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListAuditExportJobsQueryInput = z.infer<typeof listAuditExportJobsQuerySchema>;
