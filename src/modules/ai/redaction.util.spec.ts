import { redactSensitiveData } from "./redaction.util";

describe("redactSensitiveData", () => {
  it("returns empty/falsy input unchanged", () => {
    expect(redactSensitiveData("")).toBe("");
  });

  it("redacts email addresses", () => {
    expect(redactSensitiveData("Contact me at jane.doe@example.com please")).toBe(
      "Contact me at [REDACTED_EMAIL] please",
    );
  });

  it("redacts US-style phone numbers", () => {
    expect(redactSensitiveData("Call me at 415-555-0199 today")).toBe(
      "Call me at [REDACTED_PHONE] today",
    );
  });

  it("redacts SSN-style numbers", () => {
    expect(redactSensitiveData("My SSN is 123-45-6789")).toBe("My SSN is [REDACTED_SSN]");
  });

  it("redacts credit-card-like digit sequences", () => {
    expect(redactSensitiveData("Card: 4111 1111 1111 1111")).toBe("Card: [REDACTED_CARD]");
  });

  it("redacts Bearer tokens", () => {
    expect(redactSensitiveData("Authorization: Bearer abcdef1234567890xyz")).toBe(
      "Authorization: Bearer [REDACTED_TOKEN]",
    );
  });

  it("redacts recognizable API key prefixes", () => {
    expect(redactSensitiveData("key is sk-abcdefghijklmnopqrstuvwx")).toBe(
      "key is [REDACTED_TOKEN]",
    );
  });

  it("leaves ordinary support-ticket text untouched", () => {
    const text = "The login button on the dashboard is unresponsive after the last update.";
    expect(redactSensitiveData(text)).toBe(text);
  });
});
