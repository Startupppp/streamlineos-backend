import { sql } from "drizzle-orm";
import {
  listDueReviewsQuerySchema,
  listReviewsQuerySchema,
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
  for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "groupBy", "limit"]) {
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

describe("listReviewsQuerySchema", () => {
  it("accepts valid status and type values", () => {
    expect(() =>
      listReviewsQuerySchema.parse({ status: "pending", type: "approval" }),
    ).not.toThrow();
  });

  it("accepts all valid status values", () => {
    for (const s of ["pending", "approved", "rejected", "expired"]) {
      expect(() => listReviewsQuerySchema.parse({ status: s })).not.toThrow();
    }
  });

  it("rejects an unknown status value", () => {
    expect(() => listReviewsQuerySchema.parse({ status: "unknown" })).toThrow();
  });

  it("rejects an unknown type value", () => {
    expect(() => listReviewsQuerySchema.parse({ type: "invalid" })).toThrow();
  });

  it("rejects extra keys (.strict())", () => {
    expect(() => listReviewsQuerySchema.parse({ extra: "field" })).toThrow();
  });

  it("accepts an empty object — all fields optional", () => {
    expect(() => listReviewsQuerySchema.parse({})).not.toThrow();
  });
});

describe("listDueReviewsQuerySchema", () => {
  it("accepts a valid cursor pair", () => {
    expect(() =>
      listDueReviewsQuerySchema.parse({
        afterDueAt: "2026-09-01T00:00:00.000Z",
        afterId: "42",
      }),
    ).not.toThrow();
  });

  it("accepts an empty object — no cursor", () => {
    expect(() => listDueReviewsQuerySchema.parse({})).not.toThrow();
  });

  it("rejects afterDueAt without afterId", () => {
    expect(() =>
      listDueReviewsQuerySchema.parse({ afterDueAt: "2026-09-01T00:00:00.000Z" }),
    ).toThrow();
  });

  it("rejects afterId without afterDueAt", () => {
    expect(() => listDueReviewsQuerySchema.parse({ afterId: "42" })).toThrow();
  });

  it("rejects an invalid datetime for afterDueAt", () => {
    expect(() =>
      listDueReviewsQuerySchema.parse({ afterDueAt: "not-a-date", afterId: "42" }),
    ).toThrow();
  });

  it("rejects extra keys (.strict())", () => {
    expect(() => listDueReviewsQuerySchema.parse({ extra: "field" })).toThrow();
  });

  it("rejects an empty afterId string", () => {
    expect(() =>
      listDueReviewsQuerySchema.parse({
        afterDueAt: "2026-09-01T00:00:00.000Z",
        afterId: "",
      }),
    ).toThrow();
  });
});

describe("KbPageReviewsQueryService — canonical authorization seam", () => {
  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
    authMock.assertPageAccess.mockClear();
  });

  it("consults visiblePagePredicate with action 'view' so space and grant pages appear in due-review queue", async () => {
    const { chain } = makeChain();
    const db = { select: jest.fn().mockReturnValue(chain) } as never;
    const accessMock = {} as never;
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.listDue(makeUser());

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
