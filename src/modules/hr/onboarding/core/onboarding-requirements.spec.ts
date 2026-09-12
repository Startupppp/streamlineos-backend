import { resolveCountryRequirements } from "./onboarding-requirements.catalog";
import { bankDetailsSchema, personalDetailsSchema } from "./dto/onboarding.schemas";
import { genderEnum } from "../../../../db/schema/common/enums";

describe("resolveCountryRequirements", () => {
  it("maps supported countries to their bank scheme", () => {
    expect(resolveCountryRequirements("IN").bankScheme).toBe("IFSC");
    expect(resolveCountryRequirements("us").bankScheme).toBe("ABA_ROUTING");
    expect(resolveCountryRequirements("GB").bankScheme).toBe("SORT_CODE");
    expect(resolveCountryRequirements("AE").bankScheme).toBe("IBAN");
    expect(resolveCountryRequirements("SG").bankScheme).toBe("SWIFT_ACCOUNT");
    expect(resolveCountryRequirements("AU").bankScheme).toBe("BSB");
  });

  it("gives IBAN countries an IBAN scheme even without an explicit pack", () => {
    expect(resolveCountryRequirements("FR").bankScheme).toBe("IBAN");
    expect(resolveCountryRequirements("DE").bankScheme).toBe("IBAN");
  });

  it("falls back to a generic pack for other countries", () => {
    expect(resolveCountryRequirements("JP").bankScheme).toBe("GENERIC");
    expect(resolveCountryRequirements("").bankScheme).toBe("GENERIC");
  });
});

describe("bankDetailsSchema", () => {
  const base = { accountHolder: "Ada Lovelace", bankName: "Test Bank" };

  it("accepts a valid Indian record and its PAN", () => {
    const result = bankDetailsSchema.safeParse({
      ...base,
      countryCode: "IN",
      accountNumber: "12345678",
      routingCode: "HDFC0001234",
      statutory: { pan: "ABCDE1234F" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid IFSC", () => {
    const result = bankDetailsSchema.safeParse({
      ...base,
      countryCode: "IN",
      accountNumber: "12345678",
      routingCode: "BADCODE",
      statutory: { pan: "ABCDE1234F" },
    });
    expect(result.success).toBe(false);
  });

  it("requires the country's statutory field", () => {
    const result = bankDetailsSchema.safeParse({
      ...base,
      countryCode: "US",
      accountNumber: "12345678",
      routingCode: "021000021",
      statutory: {},
    });
    expect(result.success).toBe(false);
  });

  it("validates an IBAN scheme against the iban field", () => {
    const result = bankDetailsSchema.safeParse({
      ...base,
      countryCode: "AE",
      iban: "AE070331234567890123456",
      statutory: { emirates_id: "784-1234-1234567-1" },
    });
    expect(result.success).toBe(true);
  });

  it.each(["accountHolder", "bankName"] as const)(
    "rejects a record missing %s, so the client form is not the only guard",
    (field) => {
      const payload: Record<string, unknown> = {
        ...base,
        countryCode: "IN",
        accountNumber: "12345678",
        routingCode: "HDFC0001234",
        statutory: { pan: "ABCDE1234F" },
      };
      delete payload[field];
      expect(bankDetailsSchema.safeParse(payload).success).toBe(false);
    },
  );
});

describe("personalDetailsSchema — server-side required-field policy", () => {
  const valid = {
    phone: "+919876543210",
    dateOfBirth: "1995-05-05",
    emergencyName: "Ada Lovelace",
    emergencyRelation: "Parent",
    emergencyPhone: "+919876543211",
  };

  it("accepts a complete new-joiner record with no address", () => {
    expect(personalDetailsSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    "phone",
    "dateOfBirth",
    "emergencyName",
    "emergencyRelation",
    "emergencyPhone",
  ] as const)("rejects a record missing %s", (field) => {
    const payload: Record<string, unknown> = { ...valid };
    delete payload[field];
    expect(personalDetailsSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts every gender the database column declares and rejects anything else", () => {
    for (const value of genderEnum.enumValues)
      expect(personalDetailsSchema.safeParse({ ...valid, gender: value }).success).toBe(true);
    expect(
      personalDetailsSchema.safeParse({ ...valid, gender: "PREFER_NOT_TO_SAY" }).success,
    ).toBe(false);
  });

  it("rejects recruitment-only fields the employee wizard must never collect", () => {
    expect(
      personalDetailsSchema.safeParse({ ...valid, yearsOfExperience: 5 }).success,
    ).toBe(false);
    expect(
      personalDetailsSchema.safeParse({ ...valid, skills: ["react"] }).success,
    ).toBe(false);
  });

  it("rejects a partial address rather than storing half of one", () => {
    expect(
      personalDetailsSchema.safeParse({
        ...valid,
        addressCountry: "India",
        addressState: "Karnataka",
      }).success,
    ).toBe(false);
  });
});
