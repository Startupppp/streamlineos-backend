import { resolveCountryRequirements } from "./onboarding-requirements.catalog";
import { bankDetailsSchema } from "./dto/onboarding.schemas";

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
});
