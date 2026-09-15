import { resolveActivityActorName } from "./projects-activity-actor-name";

describe("resolveActivityActorName", () => {
  it("prefers the directory display name", () => {
    expect(
      resolveActivityActorName({
        displayName: "Asha Rao",
        firstName: "Asha",
        lastName: "Rao",
        userName: "asha",
        userEmail: "asha@example.com",
      }),
    ).toBe("Asha Rao");
  });

  it("falls back to the directory first and last name", () => {
    expect(
      resolveActivityActorName({
        displayName: null,
        firstName: "Asha",
        lastName: "Rao",
        userName: null,
        userEmail: null,
      }),
    ).toBe("Asha Rao");
  });

  it("uses the account name when the person has no directory record", () => {
    expect(
      resolveActivityActorName({
        displayName: null,
        firstName: null,
        lastName: null,
        userName: "Asha Rao",
        userEmail: "asha@example.com",
      }),
    ).toBe("Asha Rao");
  });

  it("uses the email local part when there is no name anywhere", () => {
    expect(
      resolveActivityActorName({
        displayName: null,
        firstName: null,
        lastName: null,
        userName: null,
        userEmail: "asha@example.com",
      }),
    ).toBe("asha");
  });

  it("says Former member only when the membership resolves to nobody", () => {
    expect(
      resolveActivityActorName({
        displayName: null,
        firstName: null,
        lastName: null,
        userName: null,
        userEmail: null,
      }),
    ).toBe("Former member");
  });

  it("ignores whitespace-only names rather than rendering a blank author", () => {
    expect(
      resolveActivityActorName({
        displayName: "   ",
        firstName: "  ",
        lastName: "  ",
        userName: " ",
        userEmail: "asha@example.com",
      }),
    ).toBe("asha");
  });
});
