import { setupSchema } from "./dto/org.schemas";
import { ownerProfileUpdate } from "./owner-profile-update";

/**
 * HRMS-E2E-025. The owner appeared as `ywpkpz+7po5eetnm3vno` in the directory,
 * the org chart and every export — the local part of their sign-up address.
 *
 * Nothing was wrong at display time; `getUserDisplayName` falls back to the
 * local part when a person has no name, which is the right thing to do with
 * nothing to show. Sign-up collects an address and nothing else, and org setup
 * asked for the company's name, industry, size and phone but never the person's.
 */
const VALID = {
  industry: "Software",
  companySize: "11-50",
  enabledModules: ["hr" as const],
};

describe("org setup collects the owner's own name", () => {
  it("accepts a full name", () => {
    const parsed = setupSchema.safeParse({ ...VALID, fullName: "Joseph Mathew" });
    expect(parsed.success).toBe(true);
  });

  it("stays optional, so an existing client that never sends it still works", () => {
    // The field is added to a schema that is already live. Making it required
    // would 400 every caller that has not shipped the new field yet.
    expect(setupSchema.safeParse(VALID).success).toBe(true);
  });

  it("refuses a name longer than the column", () => {
    const parsed = setupSchema.safeParse({ ...VALID, fullName: "a".repeat(121) });
    expect(parsed.success).toBe(false);
  });

  it("still rejects an unknown key, because the schema is strict", () => {
    // BE-13. Pairs with the above: an accepted `fullName` must not mean the
    // boundary got looser.
    const parsed = setupSchema.safeParse({ ...VALID, fullNam: "typo" });
    expect(parsed.success).toBe(false);
  });
});

describe("ownerProfileUpdate", () => {
  it("writes the name the wizard collected", () => {
    expect(ownerProfileUpdate({ fullName: "Joseph Mathew" })).toEqual({
      name: "Joseph Mathew",
    });
  });

  it("writes the phone alongside it", () => {
    expect(ownerProfileUpdate({ fullName: "Asha Rao", phone: "+919845098450" })).toEqual({
      name: "Asha Rao",
      phone: "+919845098450",
    });
  });

  it("leaves a stored name alone when the field was not sent", () => {
    // The failure mode that matters. An owner who has a name from an earlier
    // sign-in must not lose it because a later submission omitted the field.
    expect(ownerProfileUpdate({ phone: "+919845098450" })).toEqual({
      phone: "+919845098450",
    });
  });

  it("treats whitespace as not sent, rather than blanking the name", () => {
    expect(ownerProfileUpdate({ fullName: "   " })).toEqual({});
  });

  it("trims what it does write", () => {
    expect(ownerProfileUpdate({ fullName: "  Joseph Mathew  " })).toEqual({
      name: "Joseph Mathew",
    });
  });

  it("writes nothing at all when nothing was supplied", () => {
    expect(ownerProfileUpdate({})).toEqual({});
  });
});
