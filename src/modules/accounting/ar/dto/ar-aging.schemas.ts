import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";

/** Query schema for the AR aging report. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

export const agingBasisSchema = z.enum(["due", "issue"]);
export type AgingBasis = z.infer<typeof agingBasisSchema>;

export const agingQuerySchema = z
  .object({
    /** Defaults to today. Everything is evaluated as it stood on this date. */
    asOf: isoDate.optional(),
    /** Age from the due date (the default) or from the issue date. */
    basis: agingBasisSchema.optional(),
    partyId: z.string().trim().min(1).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    /** Include parties whose net position is zero on the as-of date. */
    includeSettled: queryBoolean.optional(),
  })
  .strict();
export type AgingQuery = z.infer<typeof agingQuerySchema>;
