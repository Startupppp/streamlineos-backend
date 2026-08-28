import { z } from "zod";

/** INV-210. A bounded window: an unbounded scan of every movement ever is not a dashboard. */
export const throughputQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: "from must not be after to" });
export type ThroughputQueryInput = z.infer<typeof throughputQuerySchema>;
