import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { KbPageReviewsQueryService } from "./kb-page-reviews-query.service";
import { listPageReviewsQuerySchema } from "./dto/kb-page-reviews.schemas";

jest.mock("./kb-page-reviews.service", () => ({
  reviewerCanSeeAllReviews: jest.fn().mockResolvedValue(true),
}));

const authMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

const accessMock = {} as never;

function makeUser(orgId = "org-1") {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

function renderedSql(clause: unknown): string {
  if (!clause || typeof clause !== "object") return "";
  try {
    return new PgDialect().sqlToQuery(clause as SQL).sql;
  } catch {
    return "";
  }
}

type Captured = { where?: unknown };

function makeCapturingDb(rows: unknown[] = []): { db: Db; captured: Captured } {
  const captured: Captured = {};

  function buildChain(): Record<string, jest.Mock> {
    const chain: Record<string, jest.Mock> = {};
    chain.innerJoin = jest.fn().mockImplementation(() => buildChain());
    chain.leftJoin = jest.fn().mockImplementation(() => buildChain());
    chain.where = jest.fn().mockImplementation((clause: unknown) => {
      captured.where = clause;
      return {
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      };
    });
    return chain;
  }

  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue(buildChain()),
    }),
  } as unknown as Db;

  return { db, captured };
}

describe("KbPageReviewsQueryService — free-text search over the reviewed page", () => {
  afterEach(() => jest.resetAllMocks());

  it("accepts q on the reviews list query contract", () => {
    const parsed = listPageReviewsQuerySchema.parse({ q: "onboarding" });

    expect(parsed.q).toBe("onboarding");
  });

  it("pushes a full-text predicate against the page index when q is supplied", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc", q: "onboarding" });

    expect(renderedSql(captured.where)).toContain("to_tsquery");
  });

  it("omits the full-text predicate when q is absent, so the search test above is not vacuous", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc" });

    expect(renderedSql(captured.where)).not.toContain("to_tsquery");
  });

  it("never emits a leading wildcard, so the page full-text index can still serve the search", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc", q: "onboard" });

    expect(renderedSql(captured.where)).not.toContain("%onboard");
  });

  it("drops a q of only punctuation rather than sending an empty tsquery", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc", q: "!!!" });

    expect(renderedSql(captured.where)).not.toContain("to_tsquery");
  });

  it("keeps the space filter applied alongside search so the two narrow together", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), {
      limit: 10,
      sortDir: "asc",
      q: "onboarding",
      spaceId: 9,
    });

    const text = renderedSql(captured.where);
    expect(text).toContain("to_tsquery");
    expect(text).toContain("space_id");
  });
});
