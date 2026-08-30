import {
  EnvKeyProvider,
  decryptEnvelope,
  encryptEnvelope,
  getKeyProvider,
  isEnvelopeCiphertext,
  keyReferenceOf,
  resetKeyProvider,
  setKeyProvider,
} from "./envelope-encryption";

const ORIGINAL_ENV = { ...process.env };

function withKeys(keys: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(keys)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setKeyProvider(new EnvKeyProvider());
}

describe("envelope encryption", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetKeyProvider();
  });

  it("round-trips a value through a wrapped data key", () => {
    withKeys({ ENCRYPTION_KEY: "unit-test-kek", ENCRYPTION_KEY_V2: undefined });
    const ciphertext = encryptEnvelope("4111-1111-1111-1111");
    expect(ciphertext).not.toContain("4111");
    expect(decryptEnvelope(ciphertext)).toBe("4111-1111-1111-1111");
  });

  it("carries an auditable key reference in the ciphertext", () => {
    withKeys({ ENCRYPTION_KEY: "unit-test-kek", ENCRYPTION_KEY_V2: undefined });
    const ciphertext = encryptEnvelope("ABCDE1234F");
    expect(keyReferenceOf(ciphertext)).toBe("kek:v1");
    expect(isEnvelopeCiphertext(ciphertext)).toBe(true);
  });

  it("uses a distinct data key per record, so identical plaintext differs", () => {
    withKeys({ ENCRYPTION_KEY: "unit-test-kek", ENCRYPTION_KEY_V2: undefined });
    expect(encryptEnvelope("same")).not.toBe(encryptEnvelope("same"));
  });

  it("encrypts under the highest configured key and still reads the older one", () => {
    withKeys({ ENCRYPTION_KEY: "kek-one", ENCRYPTION_KEY_V2: undefined });
    const underV1 = encryptEnvelope("historic");

    withKeys({ ENCRYPTION_KEY: "kek-one", ENCRYPTION_KEY_V2: "kek-two" });
    const underV2 = encryptEnvelope("current");

    expect(keyReferenceOf(underV1)).toBe("kek:v1");
    expect(keyReferenceOf(underV2)).toBe("kek:v2");
    expect(decryptEnvelope(underV1)).toBe("historic");
    expect(decryptEnvelope(underV2)).toBe("current");
  });

  it("fails closed when the key is unavailable — never returns ciphertext or plaintext", () => {
    withKeys({ ENCRYPTION_KEY: "unit-test-kek", ENCRYPTION_KEY_V2: undefined });
    const ciphertext = encryptEnvelope("secret");

    withKeys({ ENCRYPTION_KEY: undefined, ENCRYPTION_KEY_V2: undefined });
    expect(() => decryptEnvelope(ciphertext)).toThrow(/key/i);
    expect(() => encryptEnvelope("secret")).toThrow(/key/i);
  });

  it("fails closed when the referenced key id is not configured", () => {
    withKeys({ ENCRYPTION_KEY: "kek-one", ENCRYPTION_KEY_V2: "kek-two" });
    const underV2 = encryptEnvelope("secret");

    withKeys({ ENCRYPTION_KEY: "kek-one", ENCRYPTION_KEY_V2: undefined });
    expect(() => decryptEnvelope(underV2)).toThrow(/kek:v2/);
  });

  it("rejects a tampered ciphertext rather than returning partial plaintext", () => {
    withKeys({ ENCRYPTION_KEY: "unit-test-kek", ENCRYPTION_KEY_V2: undefined });
    const ciphertext = encryptEnvelope("secret");
    const tampered = `${ciphertext.slice(0, -4)}AAAA`;
    expect(() => decryptEnvelope(tampered)).toThrow();
  });

  it("refuses to decrypt a value that is not envelope ciphertext", () => {
    withKeys({ ENCRYPTION_KEY: "unit-test-kek", ENCRYPTION_KEY_V2: undefined });
    expect(() => decryptEnvelope("plain text")).toThrow(/envelope/i);
    expect(() => decryptEnvelope("enc:v1:abc")).toThrow(/envelope/i);
    expect(isEnvelopeCiphertext("enc:v1:abc")).toBe(false);
    expect(keyReferenceOf("enc:v1:abc")).toBeNull();
  });

  it("lets a test double replace the provider without touching the environment", () => {
    const calls: string[] = [];
    setKeyProvider({
      activeKeyId: "kek:test",
      wrap: (dek) => {
        calls.push("wrap");
        return { keyId: "kek:test", wrapped: dek.toString("base64") };
      },
      unwrap: (keyId, wrapped) => {
        calls.push(`unwrap:${keyId}`);
        return Buffer.from(wrapped, "base64");
      },
    });
    const ciphertext = encryptEnvelope("through the double");
    expect(decryptEnvelope(ciphertext)).toBe("through the double");
    expect(calls).toEqual(["wrap", "unwrap:kek:test"]);
    expect(getKeyProvider().activeKeyId).toBe("kek:test");
  });
});
