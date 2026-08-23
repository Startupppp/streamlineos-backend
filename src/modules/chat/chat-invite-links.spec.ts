import { createHash } from "node:crypto";
import {
  encryptSecret,
  isEncryptedSecret,
} from "../../common/security/secret-encryption.util";

const TOKEN = "b8f2c1d0e4a69735c1f0a2b3c4d5e6f708192a3b4c5d6e7f";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("a chat invite token at rest", () => {
  it("is found by hashing what the joiner presents, not by matching a stored secret", () => {
    const stored = hashToken(TOKEN);
    expect(hashToken(TOKEN)).toBe(stored);
    expect(stored).not.toBe(TOKEN);
  });

  it("gives a different hash for a token that differs by one character", () => {
    const other = `${TOKEN.slice(0, -1)}0`;
    expect(hashToken(other)).not.toBe(hashToken(TOKEN));
  });

  it("keeps a reversible copy so the same link can be shown again", () => {
    const ciphertext = encryptSecret(TOKEN);
    expect(isEncryptedSecret(ciphertext)).toBe(true);
    expect(ciphertext).not.toContain(TOKEN);
  });

  it("does not encrypt to the same ciphertext twice, so ciphertext is unusable for lookup", () => {
    expect(encryptSecret(TOKEN)).not.toBe(encryptSecret(TOKEN));
  });
});
