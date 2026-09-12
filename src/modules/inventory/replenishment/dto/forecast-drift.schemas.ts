import { z } from "zod";

/**
 * C7 — the drift watchlist.
 *
 * `maeRatioThreshold` compares a forecast's backtest MAE against the mean weekly
 * demand it was fitted over, so one number is comparable across SKUs that sell
 * five a week and SKUs that sell five thousand. A ratio of 1 means the average
 * error is the size of the average week — a forecast that is no better than
 * guessing the mean, which is the point at which somebody should look.
 */
export const driftWatchlistQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    maeRatioThreshold: z.coerce.number().gt(0).lte(100).optional(),
    /** Only rows whose error crosses the threshold. */
    breachingOnly: z
      .union([z.literal("true"), z.literal("false")])
      .transform((v) => v === "true")
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type DriftWatchlistQuery = z.infer<typeof driftWatchlistQuerySchema>;

/** The deep report for one SKU, with the stored versions the number came from. */
export const driftDetailQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    weeks: z.coerce.number().int().min(1).max(260).optional(),
  })
  .strict();
export type DriftDetailQuery = z.infer<typeof driftDetailQuerySchema>;
