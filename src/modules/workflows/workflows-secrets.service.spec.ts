import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../../common/security/secret-encryption.util";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "w".repeat(64);
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("workflow secret encryption — round-trip", () => {
  it("decrypts back to the original plaintext", () => {
    const plaintext = "sk-live-api-key-abc123xyz";
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });
});

describe("workflow secret encryption — random IV", () => {
  it("produces a different ciphertext on every call for the same input", () => {
    const plaintext = "sk-live-api-key-abc123xyz";
    const c1 = encryptSecret(plaintext);
    const c2 = encryptSecret(plaintext);
    expect(c1).not.toBe(c2);
    expect(isEncryptedSecret(c1)).toBe(true);
    expect(isEncryptedSecret(c2)).toBe(true);
  });
});

describe("workflow secret encryption — auth-tag integrity", () => {
  it("throws on a tampered ciphertext rather than returning garbage", () => {
    const ciphertext = encryptSecret("my-api-key-value");
    const prefix = "enc:v1:";
    const buf = Buffer.from(ciphertext.slice(prefix.length), "base64");
    buf[buf.length - 1] ^= 0xff;
    const tampered = prefix + buf.toString("base64");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe("workflow secret encryption — fail-closed on missing ENCRYPTION_KEY", () => {
  it("encryptSecret does NOT throw when the key IS configured (bite proof)", () => {
    expect(() => encryptSecret("any-value")).not.toThrow();
  });

  it("encryptSecret throws when ENCRYPTION_KEY is absent (fail-closed)", () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => encryptSecret("any-value")).toThrow(/ENCRYPTION_KEY/);
    } finally {
      if (saved !== undefined) process.env.ENCRYPTION_KEY = saved;
    }
  });
});
