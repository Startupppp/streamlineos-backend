import { normalizePersonNamePart, resolvePersonDisplayName } from "./person-display-name";

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

  it("prefers a chosen account name over the composed first and last, so the card and the header agree", () => {
    expect(
      resolvePersonDisplayName({
        accountName: "Asha B. Rao",
        firstName: "Asha",
        lastName: "Rao",
      }),
    ).toBe("Asha B. Rao");
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

/**
 * Ticket 07. One policy for every surface: onboarding composes the account name
 * with it, the directory and the employee pages display it, and the CSV and the
 * profile PDF serialise it — so the same person can no longer read differently on
 * the card, the export and the letter.
 */
describe("person name normalisation", () => {
  it("collapses internal whitespace instead of carrying a double space into every surface", () => {
    expect(
      resolvePersonDisplayName({ firstName: "Ada  ", lastName: " Byron   Lovelace" }),
    ).toBe("Ada Byron Lovelace");
  });

  it("collapses the whitespace a paste brings with it", () => {
    expect(
      resolvePersonDisplayName({ displayName: "Ada\u00a0\u200bLovelace" }),
    ).toBe("Ada Lovelace");
  });

  it("leaves a legal name's letters, case and punctuation alone", () => {
    for (const name of [
      "QA",
      "McDonald",
      "van der Berg",
      "O'Brien",
      "de Souza-Silva",
      "RAJENDRAN",
    ]) {
      expect(resolvePersonDisplayName({ displayName: name })).toBe(name);
      expect(normalizePersonNamePart(name)).toBe(name);
    }
  });

  it("composes a single given part rather than leaving a stray space", () => {
    expect(resolvePersonDisplayName({ firstName: "Prince" })).toBe("Prince");
    expect(resolvePersonDisplayName({ lastName: "Rao" })).toBe("Rao");
  });
});
