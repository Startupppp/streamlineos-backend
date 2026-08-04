import { encrypt } from "../../hr/onboarding/core/crypto.helpers";
import { resolveStatutoryTaxId } from "./filings.service";

describe("resolveStatutoryTaxId", () => {
  const previousKey = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "filings-tax-id-test-key";
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  });

  it("prefers the decrypted canonical tax identifier", () => {
    expect(resolveStatutoryTaxId("CANONICAL-TAX", "CANONICAL-PAN", encrypt("LEGACY"))).toBe(
      "CANONICAL-TAX",
    );
  });

  it("uses canonical PAN before the migration fallback", () => {
    expect(resolveStatutoryTaxId(null, "CANONICAL-PAN", encrypt("LEGACY"))).toBe(
      "CANONICAL-PAN",
    );
  });

  it("decrypts legacy fallback and never emits ciphertext", () => {
    const encrypted = encrypt("LEGACY-TAX");
    expect(resolveStatutoryTaxId(null, null, encrypted)).toBe("LEGACY-TAX");
  });
});
