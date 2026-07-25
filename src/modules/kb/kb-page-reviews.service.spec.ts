import { reviewerCanSeeAllReviews } from "./kb-page-reviews.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function makeUser(over: Partial<CurrentUserContext>): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "member",
    isOrgOwner: false,
    isPlatformAdmin: false,
    permissions: [],
    enabledModules: ["kb"],
    ...over,
  } as unknown as CurrentUserContext;
}

describe("reviewerCanSeeAllReviews", () => {
  it("is true for a kb:reviews:manage holder", () => {
    expect(reviewerCanSeeAllReviews(makeUser({ permissions: ["kb:reviews:manage"] }))).toBe(true);
  });

  it("is true for org owners and platform admins", () => {
    expect(reviewerCanSeeAllReviews(makeUser({ isOrgOwner: true }))).toBe(true);
    expect(reviewerCanSeeAllReviews(makeUser({ isPlatformAdmin: true }))).toBe(true);
  });

  it("is false for a plain kb:reviews:view holder", () => {
    expect(reviewerCanSeeAllReviews(makeUser({ permissions: ["kb:reviews:view"] }))).toBe(false);
  });
});
