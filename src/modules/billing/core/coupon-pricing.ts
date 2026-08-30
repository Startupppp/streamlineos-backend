import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
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

export function couponDiscountPaise(coupon: CouponRecord, baseAmountPaise: number): number {
  const value = parseFloat(coupon.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return coupon.type === "PERCENTAGE"
    ? Math.round(baseAmountPaise * (value / 100))
    : Math.round(Math.min(value * 100, baseAmountPaise));
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
