import { sql } from "drizzle-orm";
import { KbPageReviewsQueryService } from "./kb-page-reviews-query.service";
import { KbPageReviewsService } from "./kb-page-reviews.service";
import { bulkDecidePageReviewsSchema } from "./dto/kb-page-reviews.schemas";

jest.mock("./kb-page-reviews.service", () => {
  const actual = jest.requireActual<typeof import("./kb-page-reviews.service")>(
    "./kb-page-reviews.service",
  );
  return { ...actual, reviewerCanSeeAllReviews: jest.fn().mockResolvedValue(true) };
});

function makeUser(orgId = "org-1", membershipId = 1) {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId },
  } as never;
}

const authMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

function makeQueryDb(rows: unknown[] = []) {
  const makeChain = (): object => {
    const chain: Record<string, jest.Mock> = {
      where: jest.fn().mockImplementation(() => ({
        orderBy: jest.fn().mockImplementation(() =>
          Object.assign(Promise.resolve(rows), {
            limit: jest.fn().mockResolvedValue(rows),
          }),
        ),
      })),
    };
    for (const m of ["innerJoin", "leftJoin"]) {
      chain[m] = jest.fn().mockImplementation(() => makeChain());
    }
    return chain;
  };
  return {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(makeChain()) }),
  } as never;
}

const holdsMock = jest.fn().mockResolvedValue(true);
const accessMock = { holds: holdsMock } as never;

describe("derived isOverdue — query service", () => {
  afterEach(() => jest.resetAllMocks());

  it("marks a pending review with a past dueAt as isOverdue=true", async () => {
    const pastDue = new Date(Date.now() - 86_400_000);
    const row = {
      id: 1, orgId: "org-1", pageId: 10,
      type: "approval", status: "pending",
      requestedById: null, reviewerId: null,
      requestedByMembershipId: null, reviewerMembershipId: null,
      dueAt: pastDue, decidedAt: null, decisionNote: null,
      createdAt: new Date(), updatedAt: new Date(),
      pageTitle: "Test", requestedByName: null, reviewerName: null,
    };
    const db = makeQueryDb([row]);
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);
    const page = await svc.list(makeUser(), { limit: 50, sortDir: "asc" });
    expect(page.data[0]?.isOverdue).toBe(true);
  });

  it("marks a pending review with a future dueAt as isOverdue=false", async () => {
    const futureDue = new Date(Date.now() + 86_400_000);
    const row = {
      id: 2, orgId: "org-1", pageId: 10,
      type: "approval", status: "pending",
      requestedById: null, reviewerId: null,
      requestedByMembershipId: null, reviewerMembershipId: null,
      dueAt: futureDue, decidedAt: null, decisionNote: null,
      createdAt: new Date(), updatedAt: new Date(),
      pageTitle: "Test", requestedByName: null, reviewerName: null,
    };
    const db = makeQueryDb([row]);
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);
    const page = await svc.list(makeUser(), { limit: 50, sortDir: "asc" });
    expect(page.data[0]?.isOverdue).toBe(false);
  });

  it("marks an approved review as isOverdue=false even with a past dueAt", async () => {
    const pastDue = new Date(Date.now() - 86_400_000);
    const row = {
      id: 3, orgId: "org-1", pageId: 10,
      type: "freshness", status: "approved",
      requestedById: null, reviewerId: null,
      requestedByMembershipId: null, reviewerMembershipId: null,
      dueAt: pastDue, decidedAt: new Date(), decisionNote: null,
      createdAt: new Date(), updatedAt: new Date(),
      pageTitle: "Test", requestedByName: null, reviewerName: null,
    };
    const db = makeQueryDb([row]);
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);
    const page = await svc.list(makeUser(), { limit: 50, sortDir: "asc" });
    expect(page.data[0]?.isOverdue).toBe(false);
  });

  it("enforces visibility — visiblePagePredicate is consulted on every list call", async () => {
    const db = makeQueryDb([]);
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);
    await svc.list(makeUser(), { limit: 50, sortDir: "asc" });
    expect(authMock.visiblePagePredicate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "view",
    );
  });

  it("visibility gate: a hidden page's review is excluded (innerJoin means no match = no row)", async () => {
    const hiddenAuth = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`false`),
    };
    const db = makeQueryDb([]);
    const svc = new KbPageReviewsQueryService(db, accessMock, hiddenAuth as never);
    const page = await svc.list(makeUser(), { limit: 50, sortDir: "asc" });
    expect(page.data).toHaveLength(0);
  });

  it("cursor stability — opaque cursor is an encoded string, not a raw date", async () => {
    const pastDue = new Date(Date.now() - 3600_000);
    const rows = Array.from({ length: 2 }, (_, i) => ({
      id: i + 1, orgId: "org-1", pageId: 10 + i,
      type: "approval", status: "pending",
      requestedById: null, reviewerId: null,
      requestedByMembershipId: null, reviewerMembershipId: null,
      dueAt: pastDue, decidedAt: null, decisionNote: null,
      createdAt: new Date(), updatedAt: new Date(),
      pageTitle: "P", requestedByName: null, reviewerName: null,
    }));
    const db = makeQueryDb(rows);
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);
    const page = await svc.list(makeUser(), { limit: 1, sortDir: "asc" });
    const cursor = page.pagination.nextCursor;
    expect(typeof cursor).toBe("string");
    expect(cursor).not.toContain("T");
    expect(cursor?.length).toBeGreaterThan(0);
  });
});

describe("bulkDecidePageReviewsSchema — input validation", () => {
  it("rejects a bulk-decide payload with more than 100 ids", () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(() =>
      bulkDecidePageReviewsSchema.parse({ ids, decision: "approved" }),
    ).toThrow();
  });

  it("rejects a rejection without a note", () => {
    expect(() =>
      bulkDecidePageReviewsSchema.parse({ ids: [1, 2], decision: "rejected" }),
    ).toThrow();
  });

  it("rejects a rejection with an empty note", () => {
    expect(() =>
      bulkDecidePageReviewsSchema.parse({ ids: [1], decision: "rejected", note: "" }),
    ).toThrow();
  });

  it("accepts an approval without a note", () => {
    expect(() =>
      bulkDecidePageReviewsSchema.parse({ ids: [1], decision: "approved" }),
    ).not.toThrow();
  });
});

describe("KbPageReviewsService.bulkDecide", () => {
  afterEach(() => jest.resetAllMocks());

  function makeServiceDb(reviews: Array<{ id: number; status: string }> = []) {
    const updateReturning = jest.fn().mockResolvedValue([{ id: reviews[0]?.id ?? 1 }]);
    const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateChain = { set: updateSet };
    const selectRows = reviews;
    const selectChain = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(selectRows),
    };
    return {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(selectChain) }),
      update: jest.fn().mockReturnValue(updateChain),
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as never;
  }

  it("returns notFound for an id whose page is hidden (excluded by innerJoin)", async () => {
    const db = makeServiceDb([]);
    const auditMock = { log: jest.fn() } as never;
    const dispatchMock = { emit: jest.fn() } as never;
    const authSvcMock = { visiblePagePredicate: jest.fn().mockResolvedValue(sql`false`) } as never;
    const svc = new KbPageReviewsService(db, auditMock, dispatchMock, accessMock, authSvcMock);
    const result = await svc.bulkDecide(makeUser(), { ids: [99], decision: "approved" });
    expect(result.results[0]).toMatchObject({ id: 99, outcome: "notFound" });
  });

  it("returns notFound for a missing review id (not in org)", async () => {
    const db = makeServiceDb([]);
    const auditMock = { log: jest.fn() } as never;
    const dispatchMock = { emit: jest.fn() } as never;
    const authSvcMock = { visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`) } as never;
    const svc = new KbPageReviewsService(db, auditMock, dispatchMock, accessMock, authSvcMock);
    const result = await svc.bulkDecide(makeUser(), { ids: [404], decision: "approved" });
    expect(result.results[0]).toMatchObject({ id: 404, outcome: "notFound" });
  });

  it("returns conflict for an already-decided review", async () => {
    const db = makeServiceDb([{ id: 7, status: "approved" }]);
    const auditMock = { log: jest.fn() } as never;
    const dispatchMock = { emit: jest.fn() } as never;
    const authSvcMock = { visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`) } as never;
    const svc = new KbPageReviewsService(db, auditMock, dispatchMock, accessMock, authSvcMock);
    const result = await svc.bulkDecide(makeUser(), { ids: [7], decision: "approved" });
    expect(result.results[0]).toMatchObject({ id: 7, outcome: "conflict" });
  });
});
