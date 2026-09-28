import { reviewerCanSeeAllReviews, KbPageReviewsService } from "./kb-page-reviews.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";

function makeUser(over: Partial<CurrentUserContext>): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "member",
    isOrgOwner: false,
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
      await reviewerCanSeeAllReviews(makeUser({ isOrgOwner: true }), access),
    ).toBe(true);
    expect(access.holds).toHaveBeenCalledWith(
      expect.objectContaining({ isOrgOwner: true }),
      "kb:reviews:manage",
    );
  });
});

function makeDecideDb(
  visibleReviews: Array<{ id: number; status: string }>,
  returnedUpdatedIds: number[],
): { db: Db; updateMock: jest.Mock } {
  const returningMock = jest.fn().mockResolvedValue(
    returnedUpdatedIds.map((id) => ({ id })),
  );
  const updateMock = jest.fn().mockReturnValue({
    set: () => ({
      where: () => ({
        returning: returningMock,
      }),
    }),
  });
  const db = {
    select: jest.fn().mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(visibleReviews),
        }),
      }),
    }),
    update: updateMock,
  } as unknown as Db;
  return { db, updateMock };
}

function makeDecideUser(membershipId: number | null): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    principal:
      membershipId !== null
        ? { kind: "human-session", membershipId }
        : { kind: "system-key" },
  } as unknown as CurrentUserContext;
}

const decideAuthMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

function decideService(db: Db): KbPageReviewsService {
  return new KbPageReviewsService(
    db,
    { log: jest.fn() } as never,
    { emit: jest.fn() } as never,
    { holds: jest.fn() } as never,
    decideAuthMock as never,
  );
}

describe("KbPageReviewsService.bulkDecide — collapsed UPDATE", () => {
  beforeEach(() => jest.clearAllMocks());

  it("issues exactly one UPDATE for a batch of three pending reviews — not one UPDATE per review", async () => {
    const { db, updateMock } = makeDecideDb(
      [
        { id: 1, status: "pending" },
        { id: 2, status: "pending" },
        { id: 3, status: "pending" },
      ],
      [1, 2, 3],
    );

    await decideService(db).bulkDecide(makeDecideUser(42), {
      ids: [1, 2, 3],
      decision: "approved",
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("reviews not returned by the UPDATE are conflict — the per-row race guard fires inside the collapsed UPDATE", async () => {
    const { db } = makeDecideDb(
      [
        { id: 1, status: "pending" },
        { id: 2, status: "pending" },
      ],
      [1],
    );

    const { results } = await decideService(db).bulkDecide(makeDecideUser(42), {
      ids: [1, 2],
      decision: "approved",
    });

    const r1 = results.find((r) => r.id === 1);
    const r2 = results.find((r) => r.id === 2);
    expect(r1?.outcome).toBe("succeeded");
    expect(r2?.outcome).toBe("conflict");
  });

  it("a non-pending review is conflict without touching the UPDATE — pre-checked conflict wastes no roundtrip", async () => {
    const { db, updateMock } = makeDecideDb(
      [{ id: 1, status: "approved" }],
      [],
    );

    const { results } = await decideService(db).bulkDecide(makeDecideUser(42), {
      ids: [1],
      decision: "approved",
    });

    expect(results[0]?.outcome).toBe("conflict");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a review not visible to the actor is notFound — positive control so the outcome map is not all-conflict", async () => {
    const { db } = makeDecideDb([], []);

    const { results } = await decideService(db).bulkDecide(makeDecideUser(42), {
      ids: [999],
      decision: "approved",
    });

    expect(results[0]?.outcome).toBe("notFound");
  });
});
