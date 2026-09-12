import { digestsMatch, hashToken } from "./token.util";

describe("digestsMatch", () => {
  it("matches the stored digest of the presented secret", () => {
    expect(digestsMatch(hashToken("ABCD2345"), hashToken("ABCD2345"))).toBe(true);
  });

  it("refuses a different secret", () => {
    expect(digestsMatch(hashToken("ABCD2345"), hashToken("ABCD2346"))).toBe(false);
  });

  it("refuses when nothing is stored, rather than matching an empty presentation", () => {
    expect(digestsMatch(null, "")).toBe(false);
    expect(digestsMatch(undefined, hashToken(""))).toBe(false);
  });

  it("refuses digests of different lengths without comparing them", () => {
    expect(digestsMatch("short", hashToken("short"))).toBe(false);
  });
});
