import { sql } from "drizzle-orm";
import {
  listPageReviewsQuerySchema,
} from "./dto/kb-page-reviews.schemas";
import { KbPageReviewsQueryService } from "./kb-page-reviews-query.service";
import { KbAnalyticsService } from "../help-centre/kb-analytics.service";
import { KbDocumentQueryService } from "../document-query/kb-document-query.service";

jest.mock("./kb-page-reviews.service", () => ({
  reviewerCanSeeAllReviews: jest.fn().mockResolvedValue(true),
}));

jest.mock("../core/kb-scope", () => ({
  resolveKbArticlesViewScope: jest.fn().mockResolvedValue({ denied: true, compose: jest.fn() }),
}));

function makeChain() {
  let promise: unknown;
  const chain: Record<string, jest.Mock> = {};
  for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "groupBy", "having", "limit"]) {
    chain[m] = jest.fn().mockImplementation(() => promise);
  }
  promise = Object.assign(Promise.resolve([]), chain);
  return { chain, promise: promise as Promise<unknown[]> & Record<string, jest.Mock> };
}

const authMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
};

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", isOrgOwner: false, principal: undefined } as never;
}

describe("listPageReviewsQuerySchema", () => {
  it("accepts valid status and type values", () => {
    expect(() =>
      listPageReviewsQuerySchema.parse({ status: "pending", type: "approval" }),
    ).not.toThrow();
  });

  it("accepts all valid status values including overdue", () => {
    for (const s of ["pending", "approved", "rejected", "overdue"]) {
      expect(() => listPageReviewsQuerySchema.parse({ status: s })).not.toThrow();
    }
  });

  it("rejects an unknown status value", () => {
    expect(() => listPageReviewsQuerySchema.parse({ status: "expired" })).toThrow();
  });

  it("rejects an unknown type value", () => {
    expect(() => listPageReviewsQuerySchema.parse({ type: "invalid" })).toThrow();
  });

  it("rejects extra keys (.strict())", () => {
    expect(() => listPageReviewsQuerySchema.parse({ extra: "field" })).toThrow();
  });

  it("accepts an empty object — all fields optional", () => {
    expect(() => listPageReviewsQuerySchema.parse({})).not.toThrow();
  });

  it("accepts a cursor string", () => {
    expect(() =>
      listPageReviewsQuerySchema.parse({ cursor: "some-opaque-cursor" }),
    ).not.toThrow();
  });

  it("applies default sortDir of asc", () => {
    const result = listPageReviewsQuerySchema.parse({});
    expect(result.sortDir).toBe("asc");
  });

  it("applies default limit of 50", () => {
    const result = listPageReviewsQuerySchema.parse({});
    expect(result.limit).toBe(50);
  });
});

describe("KbPageReviewsQueryService — canonical authorization seam", () => {
  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
    authMock.assertPageAccess.mockClear();
  });

  it("consults visiblePagePredicate with action 'view' so space and grant pages appear in review list", async () => {
    const { chain } = makeChain();
    const db = { select: jest.fn().mockReturnValue(chain) } as never;
    const accessMock = {} as never;
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 50, sortDir: "asc" });

    expect(authMock.visiblePagePredicate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "view",
    );
  });
});

describe("KbAnalyticsService — canonical authorization seam", () => {
  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
  });

  it("consults visiblePagePredicate with action 'view' so page analytics include pages shared with the actor", async () => {
    const { chain } = makeChain();
    const db = { select: jest.fn().mockReturnValue(chain) } as never;
    const svc = new KbAnalyticsService(db, authMock as never);

    await svc.pages(makeUser());

    expect(authMock.visiblePagePredicate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "view",
    );
  });
});

describe("KbDocumentQueryService — canonical authorization seam", () => {
  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
  });

  it("consults visiblePagePredicate with action 'view' so page search results include space and grant pages", async () => {
    const { chain } = makeChain();
    const db = { select: jest.fn().mockReturnValue(chain) } as never;
    const kbAccess = { getAccessibleSpaceIds: jest.fn().mockResolvedValue([]) } as never;
    const access = {} as never;
    const svc = new KbDocumentQueryService(db, kbAccess, access, authMock as never);

    await svc.searchDocuments(makeUser(), "onboarding", 10);

    expect(authMock.visiblePagePredicate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "view",
    );
  });
});
