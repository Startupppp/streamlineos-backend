import { isDeclaredOperator, parseOperators } from "./subject-request-operators";

/**
 * One property, and it is the whole file: an unconfigured deployment authorises
 * NOBODY.
 *
 * The failure being prevented is specific. `access.service.ts:655` returns scope
 * "all" for any organisation owner before a grant is consulted, so every tenant
 * owner on the platform holds `compliance:subject-requests:execute` the moment
 * it is catalogued. If this list ever defaults to "allow" — which is what an
 * `includes` on an empty array would give you if the emptiness were treated as
 * "unrestricted" rather than "unauthorised" — every one of them gets a
 * cross-tenant delete button and an export of anyone's data.
 */
describe("declared subject request operators", () => {
  it("authorises nobody when the deployment has not said who", () => {
    expect(isDeclaredOperator("user_1", parseOperators(undefined))).toBe(false);
    expect(isDeclaredOperator("user_1", parseOperators(""))).toBe(false);
    expect(isDeclaredOperator("user_1", parseOperators("   "))).toBe(false);
    expect(isDeclaredOperator("user_1", parseOperators(",,"))).toBe(false);
  });

  it("authorises exactly the ids named, and nobody adjacent to them", () => {
    const operators = parseOperators("user_1, user_2");

    expect(isDeclaredOperator("user_1", operators)).toBe(true);
    expect(isDeclaredOperator("user_2", operators)).toBe(true);
    expect(isDeclaredOperator("user_3", operators)).toBe(false);
    // Not a prefix match, not a substring match. An id that merely starts with
    // a declared one is a different person.
    expect(isDeclaredOperator("user_10", operators)).toBe(false);
    expect(isDeclaredOperator("", operators)).toBe(false);
  });

  it("survives the shapes a human types into an env file", () => {
    expect(parseOperators(" user_1 ,user_2, ")).toEqual(["user_1", "user_2"]);
  });
});
