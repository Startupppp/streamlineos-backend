import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { crmDealForecastModels } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { ForecastTrainingService } from "../deals/forecast/forecast-training.service";

/**
 * How often a tenant's forecast model is refitted, in days.
 *
 * Not nightly. A fit reads up to five thousand closed deals and their ledgers,
 * and a week of new closes moves fourteen coefficients by very little — so a
 * nightly refit would spend the cost of the expensive half of this job to
 * produce a model indistinguishable from yesterday's. Scoring, which is the half
 * that changes what a rep sees, runs every night regardless: a deal that sat
 * still for a week has a different age, dwell and silence today than it had on
 * Monday, and those are features.
 */
export const FORECAST_RETRAIN_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * The nightly forecast pass.
 *
 * Two jobs with different costs and different cadences, deliberately in one
 * sweep so they cannot drift apart: refit where the model is stale or missing,
 * then score the open pipeline against whatever model is now active.
 *
 * A tenant with no accepted model is asked once a week and told no again, which
 * is the correct outcome and not a failure — `train` returns a rejection rather
 * than throwing, so a tenant who cannot yet be given a learned forecast does not
 * look like an outage. The sweep counts refusals separately from errors for
 * exactly that reason.
 */
@Injectable()
export class CronCrmForecastService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly forecast: ForecastTrainingService,
  ) {}

  async sweep(now: Date = new Date()): Promise<{
    organizations: number;
    failed: number;
    trained: number;
    refused: number;
    scored: number;
  }> {
    let trained = 0;
    let refused = 0;
    let scored = 0;

    const result = await forEachOrg(this.db, "crm-deal-forecast", async (tx, orgId) => {
      const [active] = await tx
        .select({ trainedAt: crmDealForecastModels.trainedAt })
        .from(crmDealForecastModels)
        .where(
          and(
            eq(crmDealForecastModels.organizationId, orgId),
            eq(crmDealForecastModels.status, "active"),
          ),
        )
        .limit(1);

      const stale =
        active === undefined ||
        now.getTime() - active.trainedAt.getTime() >= FORECAST_RETRAIN_AFTER_DAYS * DAY_MS;

      if (stale) {
        const attempt = await this.forecast.train(orgId, now);
        if (attempt.trained) {
          trained += 1;
          /** `train` already scored the pipeline it just earned the right to score. */
          scored += attempt.scored;
          return;
        }
        refused += 1;
      }

      scored += await this.forecast.scoreOpenDeals(orgId, now);
    });

    return {
      organizations: result.succeeded,
      failed: result.failed,
      trained,
      refused,
      scored,
    };
  }
}
