import { ANNUAL_DISCOUNT_PCT, PLAN_PRICES_PAISE, PLATFORM_PRICE_CURRENCY } from "./plan-entitlements.constants";
import type { Plan } from "./dto/billing.schemas";

export interface CouponRecord {
  id: number;
  type: string;
  value: string;
  maxUses: number | null;
  usedCount: number;
  applicablePlans: string[] | null;
  expiresAt: Date | null;
}

export interface CouponEligible {
  eligible: true;
  couponId: number;
  type: "PERCENTAGE" | "FIXED";
  value: number;
  discountAmount: number;
}

export interface CouponRejected {
  eligible: false;
  reason: string;
}

export type CouponEvaluation = CouponEligible | CouponRejected;

export const COUPON_NOT_FOUND = "Invalid coupon code";
export const COUPON_EXPIRED = "This coupon has expired";
export const COUPON_EXHAUSTED = "This coupon has reached its usage limit";
export const COUPON_WRONG_PLAN = "This coupon is not applicable to the selected plan";
export const COUPON_ALREADY_USED = "This coupon has already been used by your organization";

/** Converts a numeric(15,2) string from Postgres to integer paise with no float arithmetic. */
function numericToPaise(valueStr: string): number {
  const dotIndex = valueStr.indexOf(".");
  if (dotIndex === -1) {
    const whole = parseInt(valueStr, 10);
    return Number.isNaN(whole) || whole < 0 ? 0 : whole * 100;
  }
  const whole = parseInt(valueStr.slice(0, dotIndex) || "0", 10);
  const fracStr = valueStr.slice(dotIndex + 1).padEnd(2, "0").slice(0, 2);
  const frac = parseInt(fracStr, 10);
  if (Number.isNaN(whole) || Number.isNaN(frac) || whole < 0) return 0;
  return whole * 100 + frac;
}

export function couponDiscountPaise(coupon: CouponRecord, baseAmountPaise: number): number {
  if (coupon.type === "FIXED") {
    const paise = numericToPaise(coupon.value);
    if (paise <= 0) return 0;
    return Math.min(paise, baseAmountPaise);
  }
  const rate = parseFloat(coupon.value);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round(baseAmountPaise * (rate / 100));
}

// One evaluator for pricing, validation and redemption — checkout used to skip all of it.
export function evaluateCoupon(input: {
  coupon: CouponRecord | undefined;
  baseAmountPaise: number;
  plan: Plan;
  alreadyRedeemedByOrg: boolean;
  now: Date;
}): CouponEvaluation {
  const { coupon, baseAmountPaise, plan, alreadyRedeemedByOrg, now } = input;
  if (!coupon) return { eligible: false, reason: COUPON_NOT_FOUND };
  if (coupon.expiresAt && coupon.expiresAt < now) return { eligible: false, reason: COUPON_EXPIRED };
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses)
    return { eligible: false, reason: COUPON_EXHAUSTED };
  if (coupon.applicablePlans && coupon.applicablePlans.length > 0 && !coupon.applicablePlans.includes(plan))
    return { eligible: false, reason: COUPON_WRONG_PLAN };
  if (alreadyRedeemedByOrg) return { eligible: false, reason: COUPON_ALREADY_USED };

  return {
    eligible: true,
    couponId: coupon.id,
    type: coupon.type === "PERCENTAGE" ? "PERCENTAGE" : "FIXED",
    value: parseFloat(coupon.value),
    discountAmount: couponDiscountPaise(coupon, baseAmountPaise),
  };
}

export const MINIMUM_CHARGE_PAISE = 100;

export function applyDiscount(baseAmountPaise: number, discountPaise: number): number {
  return Math.max(MINIMUM_CHARGE_PAISE, baseAmountPaise - discountPaise);
}

export function planBaseAmountPaise(plan: Plan, billingCycle: "monthly" | "annual", annualDiscountPct: number): number {
  const monthly = PLAN_PRICES_PAISE[plan];
  return billingCycle === "annual" ? Math.round(monthly * 12 * (1 - annualDiscountPct)) : monthly;
}

export function resolveQuotePrice(
  plan: Plan,
  billingCycle: "monthly" | "annual",
  catalogPrice: { amountMinor: number; currency: string } | null,
): { amount: number; currency: string } {
  const monthlyAmountMinor = catalogPrice?.amountMinor ?? PLAN_PRICES_PAISE[plan];
  const currency = catalogPrice?.currency ?? PLATFORM_PRICE_CURRENCY;
  return {
    amount: billingCycle === "annual"
      ? Math.round(monthlyAmountMinor * 12 * (1 - ANNUAL_DISCOUNT_PCT))
      : monthlyAmountMinor,
    currency,
  };
}
