import {
  assertEntityCountryIsolation,
  buildEntityReadiness,
  describeCountryPack,
  entityReadinessScore,
  listCountryPackDescriptors,
} from "../country-pack-registry";

describe("country pack registry", () => {
  it("lists packs with maturity and honesty", () => {
    const list = listCountryPackDescriptors();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const ind = list.find((p) => p.countryCode === "IN");
    expect(ind?.maturity).toBe("production_baseline");
    expect(ind?.payrollStatutoryBundle).toMatch(/^IN-/);
    expect(ind?.honestyLabel.toLowerCase()).toMatch(/baseline|india|production/);
  });

  it("blocks country contamination across entities", () => {
    expect(assertEntityCountryIsolation("IN", "IN").ok).toBe(true);
    expect(assertEntityCountryIsolation("IN", "AE").ok).toBe(false);
  });

  it("scores India entity readiness", () => {
    const items = buildEntityReadiness(
      {
        countryCode: "IN",
        baseCurrency: "INR",
        pan: "ABCDE1234F",
        tan: null,
        pfEstablishmentCode: "PF1",
        esiCode: null,
        ptStateCode: "KA",
      },
      describeCountryPack("IN")
        ? ({
            countryCode: "IN",
            countryName: "India",
            currency: "INR",
            defaultHolidays: [],
            complianceRequirements: [],
            sensitiveFieldKeys: [],
          } as never)
        : undefined,
    );
    const score = entityReadinessScore(items);
    expect(score.total).toBeGreaterThan(3);
    expect(items.find((i) => i.key === "pan")?.done).toBe(true);
    expect(items.find((i) => i.key === "tan")?.done).toBe(false);
  });
});
