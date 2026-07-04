import {
  detectScheme,
  inferCountryFromCurrency,
  validateIFSC,
  validateABA,
  validateSortCode,
  validateIBAN,
  validateBSB,
  validateSWIFT,
  validateGeneric,
  validateSchemeCode,
} from "../bank-validation";

describe("detectScheme", () => {
  it("IN → IFSC", () => expect(detectScheme("IN")).toBe("IFSC"));
  it("in (lowercase) → IFSC", () => expect(detectScheme("in")).toBe("IFSC"));
  it("US → ABA_ROUTING", () => expect(detectScheme("US")).toBe("ABA_ROUTING"));
  it("GB → SORT_CODE", () => expect(detectScheme("GB")).toBe("SORT_CODE"));
  it("UK alias → SORT_CODE", () => expect(detectScheme("UK")).toBe("SORT_CODE"));
  it("AU → BSB", () => expect(detectScheme("AU")).toBe("BSB"));
  it("AE → IBAN", () => expect(detectScheme("AE")).toBe("IBAN"));
  it("SG → SWIFT_ACCOUNT", () => expect(detectScheme("SG")).toBe("SWIFT_ACCOUNT"));
  it("DE (EU) → IBAN", () => expect(detectScheme("DE")).toBe("IBAN"));
  it("FR (EU) → IBAN", () => expect(detectScheme("FR")).toBe("IBAN"));
  it("NL (EU) → IBAN", () => expect(detectScheme("NL")).toBe("IBAN"));
  it("unknown country → GENERIC", () => expect(detectScheme("ZZ")).toBe("GENERIC"));
  it("empty string → GENERIC", () => expect(detectScheme("")).toBe("GENERIC"));
});

describe("inferCountryFromCurrency", () => {
  it("INR → IN", () => expect(inferCountryFromCurrency("INR")).toBe("IN"));
  it("USD → US", () => expect(inferCountryFromCurrency("USD")).toBe("US"));
  it("GBP → GB", () => expect(inferCountryFromCurrency("GBP")).toBe("GB"));
  it("EUR → DE", () => expect(inferCountryFromCurrency("EUR")).toBe("DE"));
  it("AED → AE", () => expect(inferCountryFromCurrency("AED")).toBe("AE"));
  it("SGD → SG", () => expect(inferCountryFromCurrency("SGD")).toBe("SG"));
  it("AUD → AU", () => expect(inferCountryFromCurrency("AUD")).toBe("AU"));
  it("JPY → empty string", () => expect(inferCountryFromCurrency("JPY")).toBe(""));
});

describe("validateIFSC", () => {
  it("valid IFSC passes", () => {
    const r = validateIFSC("SBIN0001234");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("IFSC");
  });

  it("valid IFSC with alphanumeric suffix", () => {
    expect(validateIFSC("HDFC0A12345").valid).toBe(true);
  });

  it("empty string fails", () => {
    const r = validateIFSC("");
    expect(r.valid).toBe(false);
    expect(r.issue).toContain("required");
  });

  it("wrong length fails", () => {
    expect(validateIFSC("SBIN001234").valid).toBe(false);
  });

  it("missing 0 in 5th position fails", () => {
    expect(validateIFSC("SBIN1001234").valid).toBe(false);
  });

  it("lowercase input is accepted (normalised to uppercase)", () => {
    expect(validateIFSC("sbin0001234").valid).toBe(true);
  });
});

describe("validateABA", () => {
  it("valid ABA routing number passes (Wells Fargo 122105155)", () => {
    const r = validateABA("122105155");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("Routing number (ABA)");
  });

  it("another valid ABA (021000021 — JPMorgan Chase NY)", () => {
    expect(validateABA("021000021").valid).toBe(true);
  });

  it("empty string fails", () => {
    expect(validateABA("").valid).toBe(false);
  });

  it("less than 9 digits fails", () => {
    expect(validateABA("12345678").valid).toBe(false);
  });

  it("more than 9 digits fails", () => {
    expect(validateABA("1234567890").valid).toBe(false);
  });

  it("non-numeric characters fail", () => {
    expect(validateABA("12345678A").valid).toBe(false);
  });

  it("9 digits with bad checksum fails", () => {
    const r = validateABA("122105156");
    expect(r.valid).toBe(false);
    expect(r.issue).toContain("checksum");
  });
});

describe("validateSortCode", () => {
  it("valid 6-digit sort code passes", () => {
    const r = validateSortCode("123456");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("Sort code");
  });

  it("sort code with dashes passes", () => {
    expect(validateSortCode("12-34-56").valid).toBe(true);
  });

  it("empty string fails", () => {
    expect(validateSortCode("").valid).toBe(false);
  });

  it("5-digit code fails", () => {
    expect(validateSortCode("12345").valid).toBe(false);
  });

  it("7-digit code fails", () => {
    expect(validateSortCode("1234567").valid).toBe(false);
  });

  it("non-numeric characters fail", () => {
    expect(validateSortCode("12345A").valid).toBe(false);
  });
});

describe("validateIBAN", () => {
  it("valid German IBAN passes (DE89370400440532013000)", () => {
    const r = validateIBAN("DE89370400440532013000");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("IBAN");
  });

  it("valid British IBAN passes (GB29NWBK60161331926819)", () => {
    expect(validateIBAN("GB29NWBK60161331926819").valid).toBe(true);
  });

  it("IBAN with spaces is normalised and validated", () => {
    expect(validateIBAN("DE89 3704 0044 0532 0130 00").valid).toBe(true);
  });

  it("empty string fails", () => {
    expect(validateIBAN("").valid).toBe(false);
  });

  it("unknown country code fails", () => {
    const r = validateIBAN("ZZ00NWBK60161331926819");
    expect(r.valid).toBe(false);
    expect(r.issue).toContain("not recognised");
  });

  it("wrong length for country fails", () => {
    const r = validateIBAN("DE89370400440532013");
    expect(r.valid).toBe(false);
    expect(r.issue).toContain("22 characters");
  });

  it("bad checksum fails (last digit altered)", () => {
    const r = validateIBAN("DE89370400440532013001");
    expect(r.valid).toBe(false);
    expect(r.issue).toContain("mod-97");
  });
});

describe("validateBSB", () => {
  it("valid 6-digit BSB passes", () => {
    const r = validateBSB("063000");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("BSB");
  });

  it("BSB with dash passes", () => {
    expect(validateBSB("063-000").valid).toBe(true);
  });

  it("empty string fails", () => {
    expect(validateBSB("").valid).toBe(false);
  });

  it("5-digit BSB fails", () => {
    expect(validateBSB("06300").valid).toBe(false);
  });

  it("non-numeric BSB fails", () => {
    expect(validateBSB("06300A").valid).toBe(false);
  });
});

describe("validateSWIFT", () => {
  it("valid 8-character BIC passes (DEUTDEDB)", () => {
    const r = validateSWIFT("DEUTDEDB");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("SWIFT/BIC");
  });

  it("valid 11-character BIC with branch passes (DEUTDEDBFRA)", () => {
    expect(validateSWIFT("DEUTDEDBFRA").valid).toBe(true);
  });

  it("lowercase BIC is accepted (normalised)", () => {
    expect(validateSWIFT("deutdedb").valid).toBe(true);
  });

  it("empty string fails", () => {
    expect(validateSWIFT("").valid).toBe(false);
  });

  it("too short (7 chars) fails", () => {
    expect(validateSWIFT("DEUTDDB").valid).toBe(false);
  });

  it("too long (12 chars) fails", () => {
    expect(validateSWIFT("DEUTDEDBFRAB1").valid).toBe(false);
  });

  it("invalid characters in institution code fail", () => {
    expect(validateSWIFT("1234DEDB").valid).toBe(false);
  });
});

describe("validateGeneric", () => {
  it("valid 8-char alphanumeric passes", () => {
    const r = validateGeneric("ABCD1234");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("Bank code");
  });

  it("minimum 4 chars passes", () => {
    expect(validateGeneric("ABCD").valid).toBe(true);
  });

  it("maximum 34 chars passes", () => {
    expect(validateGeneric("A".repeat(34)).valid).toBe(true);
  });

  it("empty string fails", () => {
    expect(validateGeneric("").valid).toBe(false);
  });

  it("3-char code (too short) fails", () => {
    expect(validateGeneric("ABC").valid).toBe(false);
  });

  it("35-char code (too long) fails", () => {
    expect(validateGeneric("A".repeat(35)).valid).toBe(false);
  });

  it("special characters fail", () => {
    expect(validateGeneric("ABCD-1234").valid).toBe(false);
  });
});

describe("validateSchemeCode (dispatch)", () => {
  it("IFSC scheme dispatches to IFSC validator", () => {
    expect(validateSchemeCode("IFSC", "SBIN0001234").valid).toBe(true);
    expect(validateSchemeCode("IFSC", "BADINPUT").valid).toBe(false);
  });

  it("ABA_ROUTING scheme dispatches correctly", () => {
    expect(validateSchemeCode("ABA_ROUTING", "122105155").valid).toBe(true);
    expect(validateSchemeCode("ABA_ROUTING", "122105156").valid).toBe(false);
  });

  it("SORT_CODE scheme dispatches correctly", () => {
    expect(validateSchemeCode("SORT_CODE", "123456").valid).toBe(true);
    expect(validateSchemeCode("SORT_CODE", "12345").valid).toBe(false);
  });

  it("IBAN scheme dispatches correctly", () => {
    expect(validateSchemeCode("IBAN", "DE89370400440532013000").valid).toBe(true);
    expect(validateSchemeCode("IBAN", "DE89370400440532013001").valid).toBe(false);
  });

  it("BSB scheme dispatches correctly", () => {
    expect(validateSchemeCode("BSB", "063000").valid).toBe(true);
    expect(validateSchemeCode("BSB", "06300").valid).toBe(false);
  });

  it("SWIFT_ACCOUNT scheme dispatches correctly", () => {
    expect(validateSchemeCode("SWIFT_ACCOUNT", "DEUTDEDB").valid).toBe(true);
    expect(validateSchemeCode("SWIFT_ACCOUNT", "BAD").valid).toBe(false);
  });

  it("GENERIC scheme dispatches correctly", () => {
    expect(validateSchemeCode("GENERIC", "ABCD1234").valid).toBe(true);
    expect(validateSchemeCode("GENERIC", "AB").valid).toBe(false);
  });
});
