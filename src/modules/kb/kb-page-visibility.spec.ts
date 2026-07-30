import { eq } from "drizzle-orm";
import { pageVisibleTo } from "./kb-page-visibility";
import { kbPages } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    branchId: null,
    role: "member",
    permissions: [],
    enabledModules: [],
    plan: null,
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("pageVisibleTo", () => {
  it("returns same condition as eq(orgId) for org owner", () => {
    const user = makeUser({ isOrgOwner: true });
    const result = pageVisibleTo(user);
    const expected = eq(kbPages.orgId, user.orgId);
    expect(result).toStrictEqual(expected);
  });


  it("returns a different (SQL) condition for regular user", () => {
    const user = makeUser();
    const result = pageVisibleTo(user);
    const ownerResult = pageVisibleTo(makeUser({ isOrgOwner: true }));
    expect(result).toBeDefined();
    expect(result).not.toStrictEqual(ownerResult);
  });
});