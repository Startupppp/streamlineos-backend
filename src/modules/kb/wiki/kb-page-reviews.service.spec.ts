import { reviewerCanSeeAllReviews } from "./kb-page-reviews.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(over: Partial<CurrentUserContext>): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "member",
    isOrgOwner: false,
    permissions: [],
    enabledModules: ["kb"],
    ...over,
  } as unknown as CurrentUserContext;
}

function makeAccess(result: boolean): Pick<AccessService, "holds"> {
  return { holds: jest.fn().mockResolvedValue(result) };
}

describe("reviewerCanSeeAllReviews", () => {
  it("is true when the seam grants kb:reviews:manage", async () => {
    expect(await reviewerCanSeeAllReviews(makeUser({}), makeAccess(true))).toBe(true);
  });

  it("is false when the seam denies kb:reviews:manage", async () => {
    expect(await reviewerCanSeeAllReviews(makeUser({}), makeAccess(false))).toBe(false);
  });

  it("is true for an org owner who holds nothing explicitly — seam is sole authority", async () => {
    const access = makeAccess(true);
    expect(
      await reviewerCanSeeAllReviews(makeUser({ isOrgOwner: true, permissions: [] }), access),
    ).toBe(true);
    expect(access.holds).toHaveBeenCalledWith(
      expect.objectContaining({ isOrgOwner: true }),
      "kb:reviews:manage",
    );
  });
});
