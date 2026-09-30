import { createOrganizationSchema } from "./organization.schemas";

/**
 * BUG-HRMS-009. The create form collected a name and an optional billing email,
 * so an organization's country and time zone were whatever the columns defaulted
 * to. Both are accepted now, and both are still optional — the India-first
 * defaults are correct for the common case and must keep working untouched.
 */

const BASE = { name: "Alpha Digital Technologies Pvt Ltd", slug: "alpha-digital" };

describe("createOrganizationSchema — country and time zone", () => {
  it("still accepts a create with neither, leaving the column defaults", () => {
    const parsed = createOrganizationSchema.parse(BASE);
    expect(parsed.country).toBeUndefined();
    expect(parsed.timezone).toBeUndefined();
  });

  it("accepts an ISO country code and upper-cases it", () => {
    expect(createOrganizationSchema.parse({ ...BASE, country: "in" }).country).toBe("IN");
  });

  it("refuses a country that is not a two-letter code", () => {
    expect(() => createOrganizationSchema.parse({ ...BASE, country: "India" })).toThrow();
  });

  it("accepts a real IANA time zone", () => {
    expect(createOrganizationSchema.parse({ ...BASE, timezone: "Asia/Kolkata" }).timezone).toBe(
      "Asia/Kolkata",
    );
  });

  it("refuses a time zone the runtime does not know", () => {
    // A typo here would otherwise be stored and then silently shift every leave
    // date and payroll cut-off the org computes.
    expect(() => createOrganizationSchema.parse({ ...BASE, timezone: "Asia/Kolkatta" })).toThrow();
  });

  it("still rejects unknown keys", () => {
    expect(() => createOrganizationSchema.parse({ ...BASE, currency: "INR" })).toThrow();
  });
});
