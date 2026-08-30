import { classifyPlanChange, revenueEventPayloadSchema } from "./revenue-events";
import { summariseMovements, type RevenueMovement } from "./revenue-metrics";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";

describe("which billing state changes record a revenue event", () => {
  it("a first paid activation with no prior subscription is new business", () => {
    expect(classifyPlanChange(null, "STARTER")).toEqual({
      type: "new_subscription",
      mrr: PLAN_PRICES_PAISE.STARTER,
    });
  });

  it("a trial converting to paid is new business, not a reactivation", () => {
    expect(classifyPlanChange({ plan: "STARTER", status: "TRIAL" }, "STARTER")).toEqual({
      type: "new_subscription",
      mrr: PLAN_PRICES_PAISE.STARTER,
    });
  });

  it.each(["PAST_DUE", "CANCELLED", "SUSPENDED", "EXPIRED"])(
    "a payment against a %s subscription is a reactivation",
    (status) => {
      expect(classifyPlanChange({ plan: "STARTER", status }, "STARTER")).toEqual({
        type: "reactivation",
        mrr: PLAN_PRICES_PAISE.STARTER,
        previousPlan: "STARTER",
      });
    },
  );

  it("moving up a plan is expansion of exactly the price delta", () => {
    expect(classifyPlanChange({ plan: "STARTER", status: "ACTIVE" }, "PROFESSIONAL")).toEqual({
      type: "upgrade",
      mrr: PLAN_PRICES_PAISE.PROFESSIONAL - PLAN_PRICES_PAISE.STARTER,
      previousPlan: "STARTER",
    });
  });

  it("moving down a plan is contraction of the same magnitude", () => {
    expect(classifyPlanChange({ plan: "ENTERPRISE", status: "ACTIVE" }, "STARTER")).toEqual({
      type: "downgrade",
      mrr: PLAN_PRICES_PAISE.ENTERPRISE - PLAN_PRICES_PAISE.STARTER,
      previousPlan: "ENTERPRISE",
    });
  });

  it("renewing the plan already held moves no MRR and records nothing", () => {
    expect(classifyPlanChange({ plan: "STARTER", status: "ACTIVE" }, "STARTER")).toBeNull();
  });

  it("every movement is a non-negative magnitude — the type carries the sign", () => {
    const change = classifyPlanChange({ plan: "ENTERPRISE", status: "ACTIVE" }, "STARTER");
    expect(change?.mrr).toBeGreaterThan(0);
  });
});

describe("the outbox payload is validated on the way out again", () => {
  it("accepts a well-formed payload and defaults the optional fields", () => {
    const parsed = revenueEventPayloadSchema.parse({
      type: "new_subscription",
      orgId: "org-1",
      mrr: 99_900,
    });
    expect(parsed).toMatchObject({ plan: null, previousPlan: null, amount: null, metadata: null });
  });

  it("rejects an unknown event type rather than writing it", () => {
    expect(revenueEventPayloadSchema.safeParse({ type: "invented", orgId: "org-1", mrr: 1 }).success).toBe(false);
  });

  it("rejects fractional money — revenue stays integer paise", () => {
    expect(revenueEventPayloadSchema.safeParse({ type: "refund", orgId: "org-1", mrr: 10.5 }).success).toBe(false);
  });
});

describe("reported figures reconcile with subscription state", () => {
  const movements: RevenueMovement[] = [
    { type: "new_subscription", mrr: 500_000, count: 5, recentMrr: 500_000 },
    { type: "upgrade", mrr: 300_000, count: 2, recentMrr: 150_000 },
    { type: "churn", mrr: 99_900, count: 1, recentMrr: 99_900 },
    { type: "refund", mrr: 0, count: 1, recentMrr: 0 },
  ];

  it("takes MRR from the subscriptions, never from the sum of new_subscription events", () => {
    const metrics = summariseMovements({ mrr: 249_900, totalActive: 2, totalTrial: 3, movements });
    expect(metrics.mrr).toBe(249_900);
    expect(metrics.arr).toBe(249_900 * 12);
  });

  it("a replayed history of new_subscription events cannot inflate the level", () => {
    const inflated: RevenueMovement[] = [
      { type: "new_subscription", mrr: 9_990_000, count: 100, recentMrr: 9_990_000 },
    ];
    const metrics = summariseMovements({ mrr: 99_900, totalActive: 1, totalTrial: 0, movements: inflated });
    expect(metrics.mrr).toBe(99_900);
  });

  it("ARPU is the level divided by the subscriptions producing it", () => {
    const metrics = summariseMovements({ mrr: 300_000, totalActive: 3, totalTrial: 0, movements: [] });
    expect(metrics.arpu).toBe(100_000);
  });

  it("reports zeroes rather than dividing by nothing when there are no subscriptions", () => {
    const metrics = summariseMovements({ mrr: 0, totalActive: 0, totalTrial: 0, movements: [] });
    expect(metrics).toMatchObject({ mrr: 0, arpu: 0, churnRate: 0, trialConversionRate: 0, refundRate: 0 });
  });

  it("expansion revenue is the last 30 days of upgrades, not all time", () => {
    const metrics = summariseMovements({ mrr: 249_900, totalActive: 2, totalTrial: 3, movements });
    expect(metrics.expansionRevenue).toBe(150_000);
  });

  it("churn and refund rates come from the movement counts", () => {
    const metrics = summariseMovements({ mrr: 249_900, totalActive: 2, totalTrial: 3, movements });
    expect(metrics.churnRate).toBe(50);
    expect(metrics.refundRate).toBe(20);
  });
});
