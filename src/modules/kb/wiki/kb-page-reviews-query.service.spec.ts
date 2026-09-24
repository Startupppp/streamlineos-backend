import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { KbPageReviewsQueryService } from "./kb-page-reviews-query.service";
import { encodeCursor } from "../../../common/pagination/cursor";

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

type Captured = { where?: unknown; orderByArgs?: unknown[] };

function makeCapturingDb(rows: unknown[] = []): { db: Db; captured: Captured } {
  const captured: Captured = {};

  function buildChain(): Record<string, jest.Mock> {
    const chain: Record<string, jest.Mock> = {};
    chain.innerJoin = jest.fn().mockImplementation(() => buildChain());
    chain.leftJoin = jest.fn().mockImplementation(() => buildChain());
    chain.where = jest.fn().mockImplementation((clause: unknown) => {
      captured.where = clause;
      return {
        orderBy: jest.fn().mockImplementation((...args: unknown[]) => {
          captured.orderByArgs = args;
          return { limit: jest.fn().mockResolvedValue(rows) };
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

const NON_NULL_CURSOR = encodeCursor({ sortValue: "2025-06-15T10:00:00.000Z", id: "42" });
const NULL_CURSOR = encodeCursor({ sortValue: "9999-12-31T00:00:00.000Z", id: "42" });

describe("KbPageReviewsQueryService — cursor predicate direction", () => {
  afterEach(() => jest.resetAllMocks());

  it("with sortDir asc and a non-null cursor, the keyset predicate uses > so later pages advance forward", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc", cursor: NON_NULL_CURSOR });

    expect(renderedSql(captured.where)).toContain(">");
  });

  it("with sortDir desc and a non-null cursor, the keyset predicate uses < so later pages advance backward", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "desc", cursor: NON_NULL_CURSOR });

    expect(renderedSql(captured.where)).toContain("<");
  });

  it("with no cursor, neither > nor < appears in the predicate — confirming the cursor tests above are not vacuous", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc" });

    const text = renderedSql(captured.where);
    expect(text).not.toContain(">");
    expect(text).not.toContain("<");
  });

  it("ORDER BY for sortDir asc uses asc so the sort direction and cursor predicate agree", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc", cursor: NON_NULL_CURSOR });

    const orderText = (captured.orderByArgs ?? []).map(renderedSql).join(" ");
    expect(orderText).toContain("asc");
    expect(orderText).not.toContain("desc");
  });

  it("ORDER BY for sortDir desc uses desc so the sort direction and cursor predicate agree", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "desc", cursor: NON_NULL_CURSOR });

    const orderText = (captured.orderByArgs ?? []).map(renderedSql).join(" ");
    expect(orderText).toContain("desc");
    expect(orderText).not.toContain("asc");
  });
});

describe("KbPageReviewsQueryService — NULL dueAt ordering", () => {
  afterEach(() => jest.resetAllMocks());

  it("with sortDir asc and a non-null cursor, the predicate includes an OR isNull(dueAt) so null rows appear on later pages", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc", cursor: NON_NULL_CURSOR });

    expect(renderedSql(captured.where)).toContain("is null");
  });

  it("with sortDir desc and a non-null cursor, the predicate has no isNull branch so null rows are not re-served after they have been paged first", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "desc", cursor: NON_NULL_CURSOR });

    expect(renderedSql(captured.where)).not.toContain("is null");
  });

  it("with sortDir asc and the null sentinel cursor, the predicate uses > on id so remaining null rows are served in ascending id order", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "asc", cursor: NULL_CURSOR });

    const text = renderedSql(captured.where);
    expect(text).toContain("is null");
    expect(text).toContain(">");
  });

  it("with sortDir desc and the null sentinel cursor, the predicate uses < on id and includes is not null so non-null rows follow on the next page", async () => {
    const { db, captured } = makeCapturingDb();
    const svc = new KbPageReviewsQueryService(db, accessMock, authMock as never);

    await svc.list(makeUser(), { limit: 10, sortDir: "desc", cursor: NULL_CURSOR });

    const text = renderedSql(captured.where);
    expect(text).toContain("is null");
    expect(text).toContain("<");
    expect(text).toContain("is not null");
  });
});
