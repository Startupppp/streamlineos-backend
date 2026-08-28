import { EnvKeyProvider, resetKeyProvider, setKeyProvider } from "./envelope-encryption";
import { encrypt as encryptLegacy } from "../../modules/hr/onboarding/core/crypto.helpers";
import {
  isSealed,
  readSensitive,
  readSensitiveJson,
  sealKeyReference,
  sealSensitive,
  sealSensitiveJson,
} from "./sensitive-field";

const ORIGINAL_ENV = { ...process.env };

function withKey(value: string | undefined): void {
  if (value === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = value;
  setKeyProvider(new EnvKeyProvider());
}

describe("sensitive field codec", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetKeyProvider();
  });

  it("round-trips through the envelope scheme", () => {
    withKey("codec-test-kek");
    const sealed = sealSensitive("ABCDE1234F");
    expect(sealed.startsWith("enc:v2:")).toBe(true);
    expect(readSensitive(sealed)).toBe("ABCDE1234F");
    expect(sealKeyReference(sealed)).toBe("kek:v1");
  });

  it("still reads a legacy enc:v1 value written before the envelope scheme", () => {
    withKey("codec-test-kek");
    const legacy = encryptLegacy("legacy-tax-id");
    expect(readSensitive(legacy)).toBe("legacy-tax-id");
    expect(isSealed(legacy)).toBe(true);
    expect(sealKeyReference(legacy)).toBe("legacy:v1");
  });

  it("re-seals a legacy value onto the envelope scheme without losing the plaintext", () => {
    withKey("codec-test-kek");
    const resealed = sealSensitive(encryptLegacy("legacy-tax-id"));
    expect(resealed.startsWith("enc:v2:")).toBe(true);
    expect(readSensitive(resealed)).toBe("legacy-tax-id");
  });

  it("refuses a value that was never encrypted", () => {
    withKey("codec-test-kek");
    expect(() => readSensitive("ABCDE1234F")).toThrow(/not encrypted/i);
    expect(isSealed("ABCDE1234F")).toBe(false);
  });

  it("fails closed on both schemes when the key is gone", () => {
    withKey("codec-test-kek");
    const envelope = sealSensitive("secret");
    const legacy = encryptLegacy("secret");

    withKey(undefined);
    expect(() => readSensitive(envelope)).toThrow();
    expect(() => readSensitive(legacy)).toThrow();
    expect(() => sealSensitive("secret")).toThrow();
  });

  it("round-trips a structured payload such as bank details", () => {
    withKey("codec-test-kek");
    const details = { accountNumber: "000123456789", ifsc: "HDFC0000123" };
    const sealed = sealSensitiveJson(details);
    expect(sealed).not.toContain("000123456789");
    expect(readSensitiveJson(sealed, (value) => value as typeof details)).toEqual(details);
  });
});
