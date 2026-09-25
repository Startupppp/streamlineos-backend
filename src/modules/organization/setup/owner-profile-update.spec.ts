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

  it("refuses a submission with no name at all", () => {
    // V-023. This case previously asserted the field stayed optional, on the
    // grounds that a live schema should not 400 an older client. That left
    // "required" as a wizard-only rule, so any other caller of the route could
    // still create an organisation with no founder name — which is exactly the
    // defect. The wizard has shipped the field; the server now agrees with it.
    expect(setupSchema.safeParse(VALID).success).toBe(false);
  });

  it("refuses a whitespace-only name rather than storing a blank one", () => {
    expect(setupSchema.safeParse({ ...VALID, fullName: "   " }).success).toBe(false);
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
      firstName: "Joseph",
      lastName: "Mathew",
    });
  });

  it("splits the collected full name into first and last", () => {
    // V-023. The passwordless sign-up path seeds
    // `firstName = <email local part>, lastName = ""`, so writing only
    // `users.name` here leaves the employee detail heading, the avatar initials
    // and the profile PDF — everything that composes first + last — still
    // showing `ywpkpz+7po5eetnm3vno`.
    expect(ownerProfileUpdate({ fullName: "Asha Lakshmi Rao" })).toEqual({
      name: "Asha Lakshmi Rao",
      firstName: "Asha",
      lastName: "Lakshmi Rao",
    });
  });

  it("gives a single-word name no family name rather than duplicating it", () => {
    // Same rule sign-up uses, so the two paths cannot disagree about a person.
    expect(ownerProfileUpdate({ fullName: "Prasad" })).toEqual({
      name: "Prasad",
      firstName: "Prasad",
      lastName: "",
    });
  });

  it("writes the phone alongside it", () => {
    expect(ownerProfileUpdate({ fullName: "Asha Rao", phone: "+919845098450" })).toEqual({
      name: "Asha Rao",
      firstName: "Asha",
      lastName: "Rao",
      phone: "+919845098450",
    });
  });

  it("leaves a stored first name alone when the field was not sent", () => {
    // The patch carries no name keys at all, so an owner who already has a
    // first name from an earlier sign-in does not get it blanked by a later
    // submission that omitted the field.
    const patch = ownerProfileUpdate({ phone: "+919845098450" });
    expect(patch).not.toHaveProperty("firstName");
    expect(patch).not.toHaveProperty("lastName");
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
      firstName: "Joseph",
      lastName: "Mathew",
    });
  });

  it("writes nothing at all when nothing was supplied", () => {
    expect(ownerProfileUpdate({})).toEqual({});
  });
});
