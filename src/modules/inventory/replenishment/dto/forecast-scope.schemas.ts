import { z } from "zod";

/**
 * C1 — the warehouse a forecast question is about.
 *
 * Every forecast surface takes this, because the same variant is routinely short
 * in one warehouse and long in another and an organisation-wide answer serves
 * neither site. Omitting it still means "the whole organisation", which is what
 * these endpoints answered before — but only for a caller who holds the org-wide
 * warehouse scope; `DemandBaselineService.scopeFor` decides that, not this
 * schema.
 */
export const forecastScopeSchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    /** Weeks of demand history to fit over. Capped in the service at 260. */
    weeks: z.coerce.number().int().min(1).max(260).optional(),
  })
  .strict();
export type ForecastScopeInput = z.infer<typeof forecastScopeSchema>;

/** The same scope, plus the service level a safety-stock question needs. */
export const forecastPolicyScopeSchema = forecastScopeSchema
  .extend({ serviceLevel: z.coerce.number().gt(0).lt(1).optional() })
  .strict();
export type ForecastPolicyScopeInput = z.infer<typeof forecastPolicyScopeSchema>;

/**
 * What a stored forecast version is computed from. `horizonWeeks` is how far
 * ahead the version claims to speak — stored rather than assumed, because a
 * four-week and a twenty-six-week forecast of the same SKU are different claims
 * and comparing their accuracy without knowing which is which is meaningless.
 */
export const generateForecastSchema = z
  .object({
    warehouseId: z.number().int().positive().optional(),
    historyWeeks: z.number().int().min(1).max(260).optional(),
    horizonWeeks: z.number().int().min(1).max(52).optional(),
    serviceLevel: z.number().gt(0).lt(1).optional(),
  })
  .strict();
export type GenerateForecastBody = z.infer<typeof generateForecastSchema>;

/**
 * C2 — record a proposal for every SKU at this site that has recently sold.
 *
 * The sweep is capped rather than unbounded: each version costs a demand
 * baseline, a backtest and a lead-time read, so this is a batch a buyer asks
 * for, not a catalogue rebuild. `limit` defaults low and is hard-capped at 50 —
 * a lower ceiling than the 100 that applies to reads (§3), because these are
 * writes with real arithmetic behind each one.
 */
export const refreshForecastsSchema = z
  .object({
    warehouseId: z.number().int().positive().optional(),
    historyWeeks: z.number().int().min(1).max(260).optional(),
    limit: z.number().int().min(1).max(50).default(25),
  })
  .strict();
export type RefreshForecastsBody = z.infer<typeof refreshForecastsSchema>;

/** Paginated read over the stored history. Hard-capped at 100 like every list (§3). */
export const forecastVersionsQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ForecastVersionsQuery = z.infer<typeof forecastVersionsQuerySchema>;
