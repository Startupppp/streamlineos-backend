import {
  applyDiscount,
  couponDiscountPaise,
  evaluateCoupon,
  planBaseAmountPaise,
  COUPON_ALREADY_USED,
  COUPON_EXHAUSTED,
  COUPON_EXPIRED,
  COUPON_NOT_FOUND,
  COUPON_WRONG_PLAN,
  MINIMUM_CHARGE_PAISE,
  type CouponRecord,
} from "./coupon-pricing";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";

const NOW = new Date("2026-08-27T00:00:00.000Z");

function coupon(overrides: Partial<CouponRecord> = {}): CouponRecord {
  return {
    id: 42,
    type: "PERCENTAGE",
    value: "10",
    maxUses: null,
    usedCount: 0,
    applicablePlans: null,
    expiresAt: null,
    ...overrides,
  };
}

function evaluate(overrides: Partial<CouponRecord> = {}, extra: { alreadyRedeemedByOrg?: boolean } = {}) {
  return evaluateCoupon({
    coupon: coupon(overrides),
    baseAmountPaise: PLAN_PRICES_PAISE.STARTER,
    plan: "STARTER",
    alreadyRedeemedByOrg: extra.alreadyRedeemedByOrg ?? false,
    now: NOW,
  });
}

describe("coupon eligibility — one evaluator for pricing, validation and redemption", () => {
  it("accepts a coupon with no restrictions", () => {
    const result = evaluate();
    expect(result).toMatchObject({ eligible: true, couponId: 42, type: "PERCENTAGE", value: 10 });
  });

  it("rejects a missing coupon", () => {
    const result = evaluateCoupon({
      coupon: undefined,
      baseAmountPaise: PLAN_PRICES_PAISE.STARTER,
      plan: "STARTER",
      alreadyRedeemedByOrg: false,
      now: NOW,
    });
    expect(result).toEqual({ eligible: false, reason: COUPON_NOT_FOUND });
  });

  it("rejects an expired coupon", () => {
    expect(evaluate({ expiresAt: new Date("2026-08-26T00:00:00.000Z") })).toEqual({
      eligible: false,
      reason: COUPON_EXPIRED,
    });
  });

  it("accepts a coupon expiring in the future", () => {
    expect(evaluate({ expiresAt: new Date("2026-08-28T00:00:00.000Z") })).toMatchObject({ eligible: true });
  });

  it("rejects a coupon that does not apply to the plan", () => {
    expect(evaluate({ applicablePlans: ["ENTERPRISE"] })).toEqual({
      eligible: false,
      reason: COUPON_WRONG_PLAN,
    });
  });

  it("rejects a coupon this organisation has already redeemed", () => {
    expect(evaluate({}, { alreadyRedeemedByOrg: true })).toEqual({
      eligible: false,
      reason: COUPON_ALREADY_USED,
    });
  });

  describe("a usage limit above one is enforced at exactly that number", () => {
    it.each([0, 1, 2])("allows redemption %i of 3", (usedCount) => {
      expect(evaluate({ maxUses: 3, usedCount })).toMatchObject({ eligible: true });
    });

    it("refuses the fourth", () => {
      expect(evaluate({ maxUses: 3, usedCount: 3 })).toEqual({ eligible: false, reason: COUPON_EXHAUSTED });
    });

    it("refuses a single-use coupon on its second use", () => {
      expect(evaluate({ maxUses: 1, usedCount: 0 })).toMatchObject({ eligible: true });
      expect(evaluate({ maxUses: 1, usedCount: 1 })).toEqual({ eligible: false, reason: COUPON_EXHAUSTED });
    });
  });
});

describe("coupon arithmetic stays in integer paise", () => {
  it("rounds a percentage discount to whole paise", () => {
    expect(couponDiscountPaise(coupon({ type: "PERCENTAGE", value: "33.33" }), 99_900)).toBe(33_297);
    expect(Number.isInteger(couponDiscountPaise(coupon({ type: "PERCENTAGE", value: "33.33" }), 99_900))).toBe(true);
  });

  it("converts a fixed rupee value to paise and never exceeds the base amount", () => {
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "250" }), 99_900)).toBe(25_000);
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "5000" }), 99_900)).toBe(99_900);
  });

  it("FIXED: parses fractional rupees to paise with integer arithmetic — no float multiplication", () => {
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "250.50" }), 99_900)).toBe(25_050);
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "33.33" }), 99_900)).toBe(3_333);
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "99.99" }), 99_900)).toBe(9_999);
    expect(Number.isInteger(couponDiscountPaise(coupon({ type: "FIXED", value: "250.50" }), 99_900))).toBe(true);
  });

  it("FIXED: rejects a zero-paise coupon without charging the org", () => {
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "0" }), 99_900)).toBe(0);
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "0.00" }), 99_900)).toBe(0);
  });

  it("FIXED: ignores unparseable value strings rather than producing NaN paise", () => {
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "not-a-number" }), 99_900)).toBe(0);
    expect(couponDiscountPaise(coupon({ type: "FIXED", value: "" }), 99_900)).toBe(0);
  });

  it("treats a zero or unparseable value as no discount rather than NaN", () => {
    expect(couponDiscountPaise(coupon({ value: "0" }), 99_900)).toBe(0);
    expect(couponDiscountPaise(coupon({ value: "not-a-number" }), 99_900)).toBe(0);
  });

  it("never charges below the provider minimum", () => {
    expect(applyDiscount(99_900, 99_900)).toBe(MINIMUM_CHARGE_PAISE);
    expect(applyDiscount(99_900, 10_000)).toBe(89_900);
  });

  it("prices an annual cycle as twelve months less the annual discount", () => {
    expect(planBaseAmountPaise("STARTER", "monthly", 0.2)).toBe(PLAN_PRICES_PAISE.STARTER);
    expect(planBaseAmountPaise("STARTER", "annual", 0.2)).toBe(Math.round(PLAN_PRICES_PAISE.STARTER * 12 * 0.8));
  });
});
