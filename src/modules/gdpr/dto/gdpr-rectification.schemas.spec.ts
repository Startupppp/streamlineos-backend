import { gdprRectificationBodySchema } from "./gdpr-rectification.schemas";

describe("gdprRectificationBodySchema", () => {
  it("accepts a normalized self-service profile-name correction", () => {
    expect(
      gdprRectificationBodySchema.parse({ field: "profile.name", value: "  Ananya Rao  " }),
    ).toEqual({ field: "profile.name", value: "Ananya Rao" });
  });

  it("accepts a personal email correction with trim", () => {
    expect(
      gdprRectificationBodySchema.parse({ field: "hr_profile.personal_email", value: "  user@example.com  " }),
    ).toEqual({ field: "hr_profile.personal_email", value: "user@example.com" });
  });

  it("accepts a phone correction", () => {
    expect(
      gdprRectificationBodySchema.parse({ field: "hr_profile.phone", value: "+919876543210" }).field,
    ).toBe("hr_profile.phone");
  });

  it("accepts a date_of_birth in YYYY-MM-DD format", () => {
    expect(
      gdprRectificationBodySchema.parse({ field: "hr_profile.date_of_birth", value: "1990-05-15" }),
    ).toEqual({ field: "hr_profile.date_of_birth", value: "1990-05-15" });
  });

  it("accepts a gender correction", () => {
    expect(
      gdprRectificationBodySchema.parse({ field: "hr_profile.gender", value: "Female" }).field,
    ).toBe("hr_profile.gender");
  });

  it("accepts a preferred_name correction", () => {
    expect(
      gdprRectificationBodySchema.parse({ field: "hr_profile.preferred_name", value: "Riya" }).value,
    ).toBe("Riya");
  });

  it("accepts an address with optional sub-fields", () => {
    const result = gdprRectificationBodySchema.parse({
      field: "hr_profile.address",
      value: { city: "Mumbai", country: "India" },
    });
    expect(result).toEqual({ field: "hr_profile.address", value: { city: "Mumbai", country: "India" } });
  });

  it("accepts an emergency_contact with partial fields", () => {
    const result = gdprRectificationBodySchema.parse({
      field: "hr_profile.emergency_contact",
      value: { name: "Ramesh", phone: "+919876543211" },
    });
    expect(result).toEqual({
      field: "hr_profile.emergency_contact",
      value: { name: "Ramesh", phone: "+919876543211" },
    });
  });

  it("accepts a bank_details correction", () => {
    expect(
      gdprRectificationBodySchema.parse({ field: "hr_sensitive.bank_details", value: "ACC123" }).field,
    ).toBe("hr_sensitive.bank_details");
  });

  it("rejects unknown top-level fields", () => {
    expect(
      gdprRectificationBodySchema.safeParse({ field: "profile.email", value: "person@example.com" }).success,
    ).toBe(false);
  });

  it("rejects unknown keys inside a valid variant (strict enforcement)", () => {
    expect(
      gdprRectificationBodySchema.safeParse({ field: "profile.name", value: "Test", extra: "bad" }).success,
    ).toBe(false);
  });

  it("rejects an empty profile.name value", () => {
    expect(
      gdprRectificationBodySchema.safeParse({ field: "profile.name", value: "   " }).success,
    ).toBe(false);
  });

  it("rejects an invalid email format for hr_profile.personal_email", () => {
    expect(
      gdprRectificationBodySchema.safeParse({ field: "hr_profile.personal_email", value: "not-an-email" }).success,
    ).toBe(false);
  });

  it("rejects an invalid date format for hr_profile.date_of_birth", () => {
    expect(
      gdprRectificationBodySchema.safeParse({ field: "hr_profile.date_of_birth", value: "15-05-1990" }).success,
    ).toBe(false);
  });

  it("rejects unknown keys inside the address value (strict enforcement)", () => {
    expect(
      gdprRectificationBodySchema.safeParse({
        field: "hr_profile.address",
        value: { city: "Mumbai", unknownField: "bad" },
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid email inside emergency_contact", () => {
    expect(
      gdprRectificationBodySchema.safeParse({
        field: "hr_profile.emergency_contact",
        value: { email: "not-an-email" },
      }).success,
    ).toBe(false);
  });

  it("rejects an empty bank_details value", () => {
    expect(
      gdprRectificationBodySchema.safeParse({ field: "hr_sensitive.bank_details", value: "  " }).success,
    ).toBe(false);
  });
});
