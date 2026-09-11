import { Injectable } from "@nestjs/common";
import {
  ANNUAL_DISCOUNT_PCT,
  DEFAULT_TRIAL_DAYS,
  PLAN_LIMITS,
  type PaidPlan,
} from "../billing/core/plan-entitlements.constants";
import { annualPrice, priceList, type PlanPrice } from "../billing/core/plan-pricing";
import { regionForCountry, residencyOptions } from "../../common/region/region-placement";

/**
 * What the product costs and where the data lives, for somebody who has not
 * signed up.
 *
 * Both questions get asked before anything else in an evaluation, and both have
 * to be answerable without a login: a compliance review that must contact us to
 * find out where data rests is a review that stalls, and a price that requires a
 * demo is a price the buyer assumes is bad.
 *
 * Reads the same price table the charge path reads. A marketing page with its
 * own copy of the prices is a marketing page that eventually quotes a number we
 * do not charge.
 */

export interface PublicPlan {
  readonly plan: PaidPlan;
  readonly monthlyMinor: number;
  readonly annualMinor: number;
  /** Null is unlimited, which is what the constant means; zero would be a lie. */
  readonly seatLimit: number | null;
}

export interface PublicPricing {
  readonly currency: string;
  /**
   * False when we do not price in the currency asked for.
   *
   * The page must say so. A prospect shown a number without being told which
   * currency it is in discovers at checkout, which is the worst possible moment.
   */
  readonly isRequestedCurrency: boolean;
  readonly annualDiscountPct: number;
  readonly trialDays: number;
  readonly plans: readonly PublicPlan[];
}

@Injectable()
export class PublicPricingService {
  pricing(currency: string | null | undefined): PublicPricing {
    const prices = priceList(currency);
    const first = prices[0] as PlanPrice;

    return {
      currency: first.currency,
      isRequestedCurrency: first.isRequestedCurrency,
      annualDiscountPct: Math.round(ANNUAL_DISCOUNT_PCT * 100),
      trialDays: DEFAULT_TRIAL_DAYS,
      plans: prices.map((price) => ({
        plan: price.plan,
        monthlyMinor: price.amountMinor,
        annualMinor: annualPrice(price, ANNUAL_DISCOUNT_PCT).amountMinor,
        seatLimit: PLAN_LIMITS.members[price.plan],
      })),
    };
  }

  /** Where data rests, and — if the caller says where they are — which applies. */
  residency(country?: string | null) {
    const placement = country?.trim() ? regionForCountry(country) : null;

    return {
      options: residencyOptions(),
      ...(placement
        ? {
            likely: {
              region: placement.region,
              description: placement.description,
              // Said plainly, because a default presented as a determination is
              // how somebody discovers after migrating that it was a guess.
              isMapped: placement.isMapped,
            },
          }
        : {}),
    };
  }
}
