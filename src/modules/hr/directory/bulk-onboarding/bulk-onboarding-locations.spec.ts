import { resolveLocation, type LocationCatalog } from "./bulk-onboarding-locations";

/**
 * BUG-HRMS-006. Three locations existed in org settings and neither the wizard
 * nor the CSV could name one, so every hire landed with no work location. A CSV
 * carries the office NAME, so name, code and id all have to resolve — and an
 * unknown one has to be refused rather than quietly inventing an office.
 */

const CATALOG: LocationCatalog = {
  byKey: new Map([
    ["hyderabad office", "loc-hyd"],
    ["hyd", "loc-hyd"],
    ["remote", "loc-remote"],
  ]),
  activeIds: new Set(["loc-hyd", "loc-remote"]),
};

describe("resolveLocation", () => {
  it("resolves a location by name, case- and space-insensitively", () => {
    expect(resolveLocation({ location: "  Hyderabad Office " }, CATALOG)).toEqual({
      locationId: "loc-hyd",
    });
  });

  it("resolves a location by code", () => {
    expect(resolveLocation({ location: "HYD" }, CATALOG)).toEqual({ locationId: "loc-hyd" });
  });

  it("accepts an explicit id that belongs to the org", () => {
    expect(resolveLocation({ locationId: "loc-remote" }, CATALOG)).toEqual({
      locationId: "loc-remote",
    });
  });

  it("leaves the location unset when the row names none", () => {
    expect(resolveLocation({}, CATALOG)).toEqual({ locationId: null });
  });

  it("refuses an unknown name instead of creating an office", () => {
    const outcome = resolveLocation({ location: "Chennai Office" }, CATALOG);
    expect(outcome).toHaveProperty("error");
    expect("error" in outcome && outcome.error).toMatch(/Chennai Office/);
  });

  it("refuses an id that is not a live location of this org", () => {
    // A department id satisfies the composite FK on (org_id, location_id), so the
    // allowlist is the only thing standing between it and the location slot.
    expect(resolveLocation({ locationId: "dept-engineering" }, CATALOG)).toHaveProperty("error");
  });

  it("prefers the explicit id over a name, and still validates it", () => {
    expect(
      resolveLocation({ locationId: "loc-nope", location: "Remote" }, CATALOG),
    ).toHaveProperty("error");
  });
});
