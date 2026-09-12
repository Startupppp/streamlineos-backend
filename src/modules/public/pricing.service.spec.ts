import { PublicPricingService } from "./pricing.service";
import { PLAN_PRICES_PAISE } from "../billing/core/plan-entitlements.constants";

const service = new PublicPricingService();

describe("public pricing", () => {
  it("quotes the currency asked for", () => {
    const pricing = service.pricing("USD");

    expect(pricing.currency).toBe("USD");
    expect(pricing.isRequestedCurrency).toBe(true);
  });

  it("reads the same table the charge path reads", () => {
    // A marketing page with its own copy of the prices eventually quotes a
    // number we do not charge.
    const starter = service.pricing("INR").plans.find((p) => p.plan === "STARTER");
    expect(starter?.monthlyMinor).toBe(PLAN_PRICES_PAISE.STARTER);
  });

  it("says when it could not honour the currency", () => {
    // A prospect shown a number without being told which currency it is in
    // discovers at checkout, which is the worst possible moment.
    const pricing = service.pricing("NOK");
    expect(pricing.isRequestedCurrency).toBe(false);
    expect(pricing.currency).not.toBe("NOK");
  });

  it("answers without a currency, because a page renders before geolocation", () => {
    expect(service.pricing(null).plans).toHaveLength(3);
  });

  it("gives an annual price that is cheaper than twelve monthly", () => {
    for (const plan of service.pricing("GBP").plans)
      expect(plan.annualMinor).toBeLessThan(plan.monthlyMinor * 12);
  });

  it("reports a null seat limit as unlimited rather than as zero", () => {
    // Zero would read as "no seats", which is the opposite of what null means.
    for (const plan of service.pricing("INR").plans)
      expect(plan.seatLimit === null || plan.seatLimit > 0).toBe(true);
  });
});

describe("data residency", () => {
  it("lists every option without being asked where the caller is", () => {
    const residency = service.residency();

    expect(residency.options.map((o) => o.region).sort()).toEqual(["eu", "india", "us"]);
    expect(residency).not.toHaveProperty("likely");
  });

  it("names the likely region when the caller says where they are", () => {
    const residency = service.residency("DE");

    expect(residency.likely?.region).toBe("eu");
    expect(residency.likely?.isMapped).toBe(true);
  });

  it("says plainly when the answer is a default rather than a determination", () => {
    // A default presented as a determination is how somebody discovers after
    // migrating that it was a guess.
    expect(service.residency("BR").likely?.isMapped).toBe(false);
  });

  it("describes each option in words, not keys", () => {
    for (const option of service.residency().options) {
      expect(option.description).toMatch(/^[A-Z]/);
      expect(option.examples.length).toBeGreaterThan(0);
    }
  });
});
