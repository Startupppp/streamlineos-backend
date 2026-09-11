import type { DataScope } from "../access/access.types";
import type { ForecastBasis } from "./forecast/forecast-cold-start";

/*
  The shapes the deals forecast answers in.

  Split out of `deals-forecast.service.ts`, which re-exports all three, so every
  importer still finds them there. They live apart so `lib/forecast-summary.ts`
  can name them without importing back from the service that calls it.
*/

export interface ForecastMonth {
  month: string;
  label: string;
  weighted: number;
  bestCase: number;
  dealCount: number;
}

export interface ForecastSummary {
  totalWeighted: number;
  totalBestCase: number;
  totalDeals: number;
  byMonth: ForecastMonth[];
  byStage: Array<{
    stage: string;
    count: number;
    totalValue: number;
    weightedValue: number;
    avgProbability: number;
  }>;
  /**
   * What the totals above actually are, so a surface can stop presenting a
   * tenant's own stage percentages back to them as if the product had learned
   * something. Added, never substituted: every field above still means what it
   * meant, so a consumer that ignores `basis` is exactly as correct as before —
   * it is only as honest as before, which is the point of the field.
   */
  basis: ForecastBasis;
}

/**
 * Who a deals analytic is about.
 *
 * Declared here rather than in `deals-analytics.service.ts` or
 * `deals-forecast.service.ts`, both of which re-export it: the analytics
 * service imports the forecast service, and the forecast service imports
 * `lib/forecast-summary.ts`, which narrows by it. Declaring it in either
 * service would close a cycle.
 */
export interface DealsViewScope {
  scope: DataScope;
  userId: string;
}
