import { encrypt, decrypt, encryptBankDetails, decryptBankDetails } from "./crypto.helpers";

describe("crypto.helpers", () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "k".repeat(64);
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  it("round-trips a value", () => {
    expect(decrypt(encrypt("ABCDE1234F"))).toBe("ABCDE1234F");
  });

  it("produces ciphertext that does not contain the plaintext", () => {
    const ciphertext = encrypt("ABCDE1234F");
    expect(ciphertext.startsWith("enc:v1:")).toBe(true);
    expect(ciphertext).not.toContain("ABCDE1234F");
  });

  it("uses a fresh IV so the same plaintext encrypts differently each time", () => {
    expect(encrypt("ABCDE1234F")).not.toBe(encrypt("ABCDE1234F"));
  });

  it("passes through legacy plaintext on read (dual-mode, required by the backfill)", () => {
    expect(decrypt("ABCDE1234F")).toBe("ABCDE1234F");
  });

  it("round-trips bank details", () => {
    const details = {
      accountNumber: "000123456789",
      bankName: "Example Bank",
      branch: "Main",
      ifsc: "EXMP0000123",
      accountHolder: "A Person",
    };
    expect(decryptBankDetails(encryptBankDetails(details))).toEqual(details);
  });

  it("throws instead of silently storing plaintext when no key is configured", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("ABCDE1234F")).toThrow(/ENCRYPTION_KEY/);
  });

  it("still reads legacy plaintext when no key is configured", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(decrypt("ABCDE1234F")).toBe("ABCDE1234F");
  });
});
