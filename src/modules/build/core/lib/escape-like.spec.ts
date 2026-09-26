import { escapeLike } from "./escape-like";

describe("escapeLike — what a Build list search box sends to ILIKE", () => {
  it("leaves ordinary text untouched, so the escaping below is about the metacharacters and not about mangling every search", () => {
    expect(escapeLike("release candidate")).toBe("release candidate");
  });

  it("escapes a percent sign, because someone typing 50% means those characters and not match-anything", () => {
    expect(escapeLike("50%")).toBe("50\\%");
  });

  it("escapes an underscore, which otherwise matches any single character and makes a search for v_1 return v21", () => {
    expect(escapeLike("v_1")).toBe("v\\_1");
  });

  it("escapes a backslash, so a search ending in one cannot escape the closing wildcard and change the shape of the pattern", () => {
    expect(`%${escapeLike("path\\")}%`).toBe("%path\\\\%");
  });
});
