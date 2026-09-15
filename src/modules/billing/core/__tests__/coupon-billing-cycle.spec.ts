import { validateCouponQuerySchema } from "../dto/billing.schemas";
import { planBaseAmountPaise, evaluateCoupon } from "../coupon-pricing";

describe("coupon validation honours the billing cycle", () => {
  it("accepts billingCycle on the query, because the schema is .strict() and rejecting it was what forced the client to stop sending it", () => {
    const parsed = validateCouponQuerySchema.safeParse({
      code: "SAVE10",
      plan: "STARTER",
      billingCycle: "annual",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.billingCycle).toBe("annual");
  });

  it("still accepts a request with no billingCycle, so an older client keeps working", () => {
    const parsed = validateCouponQuerySchema.safeParse({
      code: "SAVE10",
      plan: "STARTER",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown query param, proving .strict() is still enforced", () => {
    const parsed = validateCouponQuerySchema.safeParse({
      code: "SAVE10",
      plan: "STARTER",
      notAParam: "x",
    });

    expect(parsed.success).toBe(false);
  });

  it("computes a materially larger percentage discount for an annual cycle than a monthly one, which is the amount the client was previously shown", () => {
    const annualDiscountPct = 0.1;
    const monthlyBase = planBaseAmountPaise("STARTER", "monthly", annualDiscountPct);
    const annualBase = planBaseAmountPaise("STARTER", "annual", annualDiscountPct);

    expect(annualBase).toBeGreaterThan(monthlyBase);

    const coupon = {
      id: 1,
      type: "PERCENTAGE",
      value: "10",
      expiresAt: null,
      maxUses: null,
      usedCount: 0,
      applicablePlans: null,
    };

    const monthly = evaluateCoupon({
      coupon: coupon as never,
      baseAmountPaise: monthlyBase,
      plan: "STARTER",
      alreadyRedeemedByOrg: false,
      now: new Date(),
    });
    const annual = evaluateCoupon({
      coupon: coupon as never,
      baseAmountPaise: annualBase,
      plan: "STARTER",
      alreadyRedeemedByOrg: false,
      now: new Date(),
    });

    expect(monthly.eligible).toBe(true);
    expect(annual.eligible).toBe(true);
    if (monthly.eligible && annual.eligible)
      expect(annual.discountAmount).toBeGreaterThan(monthly.discountAmount);
  });
});
