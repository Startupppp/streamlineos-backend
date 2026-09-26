import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { KbPageReviewsService } from "./kb-page-reviews.service";

function makeUser(orgId = "org-1", membershipId = 1) {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId },
  } as never;
}

function makeReviewRow(overrides: Partial<{ id: number; pageId: number; status: string }> = {}) {
  return {
    id: 42,
    orgId: "org-1",
    pageId: 7,
    status: "pending",
    requestedById: "requester-1",
    reviewerId: null,
    ...overrides,
  };
}

function makeDb(reviewRow: unknown) {
  const updateReturning = jest.fn().mockResolvedValue([{ id: 42, status: "approved" }]);
  const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  return {
    query: {
      kbPageReviews: { findFirst: jest.fn().mockResolvedValue(reviewRow) },
    },
    update: jest.fn().mockReturnValue({ set: updateSet }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([
          { id: 42, pageTitle: "Secret", requestedByName: null, reviewerName: null, status: "approved", dueAt: null },
        ]),
      }),
    }),
    updateWhere,
  } as never;
}

const audit = { log: jest.fn() } as never;
const dispatch = { emit: jest.fn() } as never;
const access = { holds: jest.fn().mockResolvedValue(true) } as never;

describe("KbPageReviewsService.approve/reject — decision must use page visibility", () => {
  afterEach(() => jest.resetAllMocks());

  it("approve throws NotFoundException (not a decision) when the review's page is hidden from the actor", async () => {
    const db = makeDb(makeReviewRow());
    const auth = {
      assertPageAccess: jest.fn().mockRejectedValue(new NotFoundException("Page not found")),
    } as never;
    const svc = new KbPageReviewsService(db, audit, dispatch, access, auth);

    const error = await svc.approve(makeUser(), 42, {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Review not found");
    expect((db as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it("reject throws NotFoundException (not a decision) when the review's page is hidden from the actor", async () => {
    const db = makeDb(makeReviewRow());
    const auth = {
      assertPageAccess: jest.fn().mockRejectedValue(new NotFoundException("Page not found")),
    } as never;
    const svc = new KbPageReviewsService(db, audit, dispatch, access, auth);

    const error = await svc.reject(makeUser(), 42, { note: "needs work" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Review not found");
    expect((db as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it("approve proceeds and decides the review once page access is confirmed", async () => {
    const db = makeDb(makeReviewRow());
    const auth = {
      assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 7, action: "view", via: "space" }),
    } as never;
    const svc = new KbPageReviewsService(db, audit, dispatch, access, auth);

    const result = await svc.approve(makeUser(), 42, {});

    expect(result.status).toBe("approved");
    expect((db as { update: jest.Mock }).update).toHaveBeenCalled();
  });

  it("a hidden-page approve rejects with the same exception a nonexistent review would, so the response cannot distinguish the two", async () => {
    const missingDb = makeDb(undefined);
    const authAllowsButFindsNoRow = { assertPageAccess: jest.fn() } as never;
    const missing = new KbPageReviewsService(missingDb, audit, dispatch, access, authAllowsButFindsNoRow);
    const missingError = await missing.approve(makeUser(), 999, {}).catch((e: unknown) => e);

    const hiddenDb = makeDb(makeReviewRow());
    const hiddenAuth = { assertPageAccess: jest.fn().mockRejectedValue(new ForbiddenException("denied")) } as never;
    const hidden = new KbPageReviewsService(hiddenDb, audit, dispatch, access, hiddenAuth);
    const hiddenError = await hidden.approve(makeUser(), 42, {}).catch((e: unknown) => e);

    expect((missingError as NotFoundException).message).toBe("Review not found");
    expect((hiddenError as NotFoundException).message).toBe("Review not found");
    expect((missingError as NotFoundException).getStatus()).toBe(
      (hiddenError as NotFoundException).getStatus(),
    );
  });
});
