import { PgDialect } from "drizzle-orm/pg-core";
import { pageVisibleTo } from "./kb-page-visibility";
import { KbAccessService } from "../core/kb-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  humanSessionPrincipal,
  ACCOUNT_ONLY_PRINCIPAL,
} from "../../../common/auth/principal";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-departed",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, false),
    ...overrides,
  };
}

const dialect = new PgDialect();

describe("KB departed-actor rendering — pageVisibleTo", () => {
  it("private page still matches the departed user via createdById (userId always in predicate)", () => {
    const user = makeUser({
      userId: "user-departed",
      principal: humanSessionPrincipal(42, false),
    });
    const pred = pageVisibleTo(user, []);
    const { sql: text, params } = dialect.sqlToQuery(pred);
    expect(text).toMatch(/created_by_id/);
    expect(params).toContain("user-departed");
  });

  it("membershipId is added to predicate when principal carries an active membership", () => {
    const user = makeUser({
      userId: "user-departed",
      principal: humanSessionPrincipal(42, false),
    });
    const pred = pageVisibleTo(user, []);
    const { sql: text, params } = dialect.sqlToQuery(pred);
    expect(text).toMatch(/created_by_membership_id/);
    expect(params).toContain(42);
  });

  it("membershipId predicate is ABSENT when principal is account-only (no active org membership)", () => {
    const user = makeUser({
      userId: "user-departed",
      principal: ACCOUNT_ONLY_PRINCIPAL,
    });
    const pred = pageVisibleTo(user, []);
    const { sql: text } = dialect.sqlToQuery(pred);
    expect(text).not.toMatch(/created_by_membership_id/);
  });

  it("account-only principal still carries userId in predicate so historical attribution renders", () => {
    const user = makeUser({
      userId: "user-departed",
      principal: ACCOUNT_ONLY_PRINCIPAL,
    });
    const pred = pageVisibleTo(user, []);
    const { params } = dialect.sqlToQuery(pred);
    expect(params).toContain("user-departed");
  });
});

describe("KB departed-actor authority — KbAccessService.assertCanViewArticle", () => {
  function makeSelectChain(rows: unknown[]) {
    const where = jest.fn().mockResolvedValue(rows);
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }) });
    const from = jest.fn().mockReturnValue({ where, innerJoin });
    return { from };
  }

  function makeDb(
    restrictions: Array<{ userId: string | null; membershipId: number | null; role: string | null }>,
  ) {
    let selectCallIdx = 0;
    const selectFn = jest.fn().mockImplementation(() => {
      selectCallIdx++;
      if (selectCallIdx === 1) {
        return makeSelectChain(restrictions);
      }
      return makeSelectChain([]);
    });
    return {
      query: {
        kbArticles: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
      select: selectFn,
      selectDistinct: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
    };
  }

  const makeAccess = () => ({ holds: jest.fn().mockResolvedValue(false) });
  const makeCache = () => ({ cachedVersioned: jest.fn().mockResolvedValue([]) });

  it("grants access when restriction row carries the caller's membershipId (preferred path)", async () => {
    const db = makeDb([{ userId: null, membershipId: 42, role: null }]);
    const svc = new KbAccessService(db as never, makeCache() as never, makeAccess() as never);
    const user = makeUser({ userId: "user-other", principal: humanSessionPrincipal(42, false) });
    const row = { id: 1, orgId: "org-1", spaceId: null };
    await expect(svc.assertCanViewArticle(user, row)).resolves.toBeUndefined();
  });

  it("denies access when restriction row targets another user and caller carries a different membershipId", async () => {
    const db = makeDb([{ userId: "other-user", membershipId: 99, role: null }]);
    const svc = new KbAccessService(db as never, makeCache() as never, makeAccess() as never);
    const user = makeUser({
      userId: "user-departed",
      principal: humanSessionPrincipal(42, false),
    });
    const row = { id: 1, orgId: "org-1", spaceId: null };
    await expect(svc.assertCanViewArticle(user, row)).rejects.toThrow("Article not found");
  });

  it("still grants access via userId when membershipId on the restriction row is null (backfill not yet run)", async () => {
    const db = makeDb([{ userId: "user-departed", membershipId: null, role: null }]);
    const svc = new KbAccessService(db as never, makeCache() as never, makeAccess() as never);
    const user = makeUser({ userId: "user-departed", principal: humanSessionPrincipal(42, false) });
    const row = { id: 1, orgId: "org-1", spaceId: null };
    await expect(svc.assertCanViewArticle(user, row)).resolves.toBeUndefined();
  });

  it("confers NO authority when departed actor is account-only and restriction row's membershipId is cleared", async () => {
    const db = makeDb([{ userId: null, membershipId: null, role: null }]);
    const svc = new KbAccessService(db as never, makeCache() as never, makeAccess() as never);
    const user = makeUser({ userId: "user-departed", principal: ACCOUNT_ONLY_PRINCIPAL });
    const row = { id: 1, orgId: "org-1", spaceId: null };
    await expect(svc.assertCanViewArticle(user, row)).rejects.toThrow("Article not found");
  });
});
