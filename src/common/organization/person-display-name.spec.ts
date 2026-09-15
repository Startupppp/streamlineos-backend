import { resolvePersonDisplayName } from "./person-display-name";

describe("resolvePersonDisplayName", () => {
  it("prefers the directory display name", () => {
    expect(
      resolvePersonDisplayName({
        displayName: "Asha Rao",
        firstName: "Asha",
        lastName: "Rao",
        accountName: "asha",
        email: "asha@example.com",
      }),
    ).toBe("Asha Rao");
  });

  it("falls back to the directory first and last name", () => {
    expect(resolvePersonDisplayName({ firstName: "Asha", lastName: "Rao" })).toBe("Asha Rao");
  });

  it("uses the account name when the person has no directory record", () => {
    expect(
      resolvePersonDisplayName({ accountName: "Asha Rao", email: "asha@example.com" }),
    ).toBe("Asha Rao");
  });

  it("uses the email local part when there is no name anywhere", () => {
    expect(resolvePersonDisplayName({ email: "asha@example.com" })).toBe("asha");
  });

  it("keeps a bare address that has no local part", () => {
    expect(resolvePersonDisplayName({ email: "@example.com" })).toBe("@example.com");
  });

  it("returns null when nothing resolves, leaving the caller to name the absence", () => {
    expect(resolvePersonDisplayName({})).toBeNull();
    expect(resolvePersonDisplayName({ displayName: null, firstName: null, email: null })).toBeNull();
  });

  it("ignores whitespace-only fields rather than rendering a blank name", () => {
    expect(
      resolvePersonDisplayName({
        displayName: "   ",
        firstName: "  ",
        lastName: "  ",
        accountName: " ",
        email: "asha@example.com",
      }),
    ).toBe("asha");
  });
});
