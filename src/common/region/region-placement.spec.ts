import {
  DEFAULT_PLACEMENT,
  PLACEMENT_REGIONS,
  isPlaceable,
  regionForCountry,
} from "./region-placement";

describe("regionForCountry", () => {
  it("places an EU customer in the EU", () => {
    // The whole reason a European customer asks before signing up.
    for (const country of ["DE", "FR", "IE", "NL", "ES", "IT"])
      expect(regionForCountry(country).region).toBe("eu");
  });

  it("places a North American customer in the United States", () => {
    for (const country of ["US", "CA", "MX"])
      expect(regionForCountry(country).region).toBe("us");
  });

  it("places a South Asian customer in India", () => {
    for (const country of ["IN", "LK", "BD"])
      expect(regionForCountry(country).region).toBe("india");
  });

  it("falls to the default for a country nobody mapped, and says so", () => {
    // Refusing to create an organisation because its country is unmapped turns a
    // signup into a support ticket. The customer is told which region instead.
    const placement = regionForCountry("BR");

    expect(placement.region).toBe(DEFAULT_PLACEMENT);
    expect(placement.isMapped).toBe(false);
  });

  it("falls to the default for an absent country rather than throwing", () => {
    for (const absent of [null, undefined, "", "  "])
      expect(regionForCountry(absent).region).toBe(DEFAULT_PLACEMENT);
  });

  it("accepts a country in any case a form might send", () => {
    expect(regionForCountry("de").region).toBe("eu");
    expect(regionForCountry(" De ").region).toBe("eu");
  });

  it("always describes the placement in words a customer can act on", () => {
    // "eu" is a key; "European Union (Ireland)" is what answers the question a
    // prospect's counsel actually asked. The property is that it reads as prose
    // -- capitalised, non-empty -- not that it is long: "India" is a complete
    // and correct answer at five characters.
    for (const country of ["DE", "US", "IN", "BR"]) {
      const { description } = regionForCountry(country);
      expect(description).toMatch(/^[A-Z]/);
      expect(description.trim()).not.toBe("");
    }
  });

  it("only ever returns a region this deployment knows about", () => {
    for (const country of ["DE", "US", "IN", "BR", "ZZ"])
      expect(PLACEMENT_REGIONS).toContain(regionForCountry(country).region);
  });
});

describe("isPlaceable", () => {
  it("accepts a placement the deployment serves", () => {
    expect(isPlaceable(regionForCountry("DE"), ["india", "eu", "us"])).toBe(true);
  });

  it("refuses a placement the deployment does not serve", () => {
    // Placing a tenant somewhere unreachable fails at the first query rather
    // than at signup, which is the wrong end.
    expect(isPlaceable(regionForCountry("DE"), ["india"])).toBe(false);
  });

  it("refuses when nothing is configured, rather than passing vacuously", () => {
    expect(isPlaceable(regionForCountry("IN"), [])).toBe(false);
  });
});

describe("regionForNewOrg", () => {
  // Imported here rather than at the top because the registry is module-level
  // state and these cases set it up and tear it down themselves.
  const load = async () => import("./region-registry");

  afterEach(async () => (await load()).clearRegionRegistry());

  it("falls back to the documented default outside a booted application", async () => {
    // Unit tests, seeds and scripts run with no registry. That path has to keep
    // working, or every one of them becomes region-aware for no reason.
    const { regionForNewOrg, DEFAULT_REGION } = await load();
    expect(regionForNewOrg()).toBe(DEFAULT_REGION);
    expect(regionForNewOrg("DE")).toBe(DEFAULT_REGION);
  });
});
