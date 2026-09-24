import { hashPublicToken, newPublicToken } from "./kb-public-token";

describe("KB public share tokens", () => {
  it("issues a token with enough entropy that guessing it is not a threat model", () => {
    const token = newPublicToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
  });

  it("issues a different token every time, so one share cannot be derived from another", () => {
    const tokens = new Set(Array.from({ length: 64 }, newPublicToken));
    expect(tokens.size).toBe(64);
  });

  it("hashes to the same hex sha256 the migration backfills with, so stored rows and fresh shares resolve identically", () => {
    expect(hashPublicToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces a hash that is stable across calls, so a lookup made later still matches the row written earlier", () => {
    const token = newPublicToken();
    expect(hashPublicToken(token)).toBe(hashPublicToken(token));
  });

  it("does not return the token itself as its hash, so storing the hash is not storing the bearer credential", () => {
    const token = newPublicToken();
    expect(hashPublicToken(token)).not.toBe(token);
  });
});
