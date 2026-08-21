import { createHmac } from "node:crypto";
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

/** Mirrors `readSigningSecret` in webhooks-dispatch.service.ts. */
function readSigningSecret(stored: string): string {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

describe("webhook signing secrets at rest", () => {
  const raw = "a".repeat(64);

  it("stores ciphertext, not the raw secret", () => {
    const stored = encryptSecret(raw);

    expect(stored).not.toContain(raw);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(isEncryptedSecret(stored)).toBe(true);
  });

  it("round-trips so the HMAC signature is unchanged by encryption", () => {
    const body = JSON.stringify({ event: "deal.won", data: {} });
    const expected = createHmac("sha256", raw).update(body).digest("hex");

    const signature = createHmac("sha256", readSigningSecret(encryptSecret(raw)))
      .update(body)
      .digest("hex");

    expect(signature).toBe(expected);
  });

  it("still signs correctly for a legacy plaintext row (lazy migration)", () => {
    const body = JSON.stringify({ event: "deal.won", data: {} });
    const expected = createHmac("sha256", raw).update(body).digest("hex");

    expect(isEncryptedSecret(raw)).toBe(false);
    const signature = createHmac("sha256", readSigningSecret(raw))
      .update(body)
      .digest("hex");

    expect(signature).toBe(expected);
  });

  it("produces a different ciphertext each time, so equal secrets are not correlatable", () => {
    expect(encryptSecret(raw)).not.toBe(encryptSecret(raw));
  });
});
