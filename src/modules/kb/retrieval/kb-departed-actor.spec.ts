import { ForbiddenException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KbAccessService } from "../core/kb-access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
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

function emptyQueryChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const self = (): Record<string, unknown> => chain;
  Object.assign(chain, {
    from: self,
    innerJoin: self,
    leftJoin: self,
    where: self,
    orderBy: self,
    groupBy: self,
    limit: self,
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  });
  return chain;
}

function makeAuthService(): KnowledgeAuthorizationService {
  const db = {
    select: () => emptyQueryChain(),
    selectDistinct: () => emptyQueryChain(),
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) } },
  };
  const cache = {
    cachedVersioned: jest
      .fn()
      .mockImplementation((_ns: unknown, _key: unknown, fill: () => Promise<unknown>) => fill()),
  };
  const access = {
    holds: jest.fn().mockResolvedValue(false),
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
  };
  return new KnowledgeAuthorizationService(db as never, cache as never, access as never);
}

async function liveViewBranch(user: CurrentUserContext): Promise<SQL<unknown>> {
  const standing = await makeAuthService().resolveStanding(user);
  return buildVisiblePageScope(standing, "view").indexedBranch;
}

describe("KB departed-actor rendering — the canonical page scope the read path runs", () => {
  it("private page still matches the departed user via createdById (userId always in predicate)", async () => {
    const { sql: text, params } = dialect.sqlToQuery(
      await liveViewBranch(
        makeUser({ userId: "user-departed", principal: humanSessionPrincipal(42, false) }),
      ),
    );

    expect(text).toMatch(/"kb_pages"\."created_by_id"/);
    expect(params).toContain("user-departed");
  });

  it("membershipId is added to predicate when principal carries an active membership", async () => {
    const { sql: text, params } = dialect.sqlToQuery(
      await liveViewBranch(
        makeUser({ userId: "user-departed", principal: humanSessionPrincipal(42, false) }),
      ),
    );

    expect(text).toMatch(/"kb_pages"\."created_by_membership_id"/);
    expect(text).toMatch(/"kb_pages"\."owner_membership_id"/);
    expect(params).toContain(42);
  });

  it("membershipId predicate is ABSENT when principal is account-only (no active org membership)", async () => {
    const { sql: text, params } = dialect.sqlToQuery(
      await liveViewBranch(
        makeUser({ userId: "user-departed", principal: ACCOUNT_ONLY_PRINCIPAL }),
      ),
    );

    expect(text).not.toMatch(/"kb_pages"\."created_by_membership_id"/);
    expect(text).not.toMatch(/"kb_pages"\."owner_membership_id"/);
    expect(params).not.toContain(42);
  });

  it("account-only principal still carries userId in predicate so historical attribution renders", async () => {
    const { params } = dialect.sqlToQuery(
      await liveViewBranch(
        makeUser({ userId: "user-departed", principal: ACCOUNT_ONLY_PRINCIPAL }),
      ),
    );

    expect(params).toContain("user-departed");
  });

  it("an account-only principal is refused a page read before any predicate runs, because membership is structural", async () => {
    const auth = makeAuthService();
    const user = makeUser({ userId: "user-departed", principal: ACCOUNT_ONLY_PRINCIPAL });

    await expect(auth.assertPageAccess(user, 7, "view")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("a principal that still carries a membership gets past the structural gate and is refused only by the predicate", async () => {
    const auth = makeAuthService();
    const user = makeUser({ userId: "user-departed", principal: humanSessionPrincipal(42, false) });

    const decision = await auth.resolvePageAccess(user, 7, "view");

    expect(decision.outcome).toBe("notFound");
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
        kbPages: {
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

  it("denies access when restriction row has null membershipId and null role (neither path matches — fail-closed)", async () => {
    const db = makeDb([{ userId: "user-departed", membershipId: null, role: null }]);
    const svc = new KbAccessService(db as never, makeCache() as never, makeAccess() as never);
    const user = makeUser({ userId: "user-departed", principal: humanSessionPrincipal(42, false) });
    const row = { id: 1, orgId: "org-1", spaceId: null };
    await expect(svc.assertCanViewArticle(user, row)).rejects.toThrow("Article not found");
  });

  it("confers NO authority when departed actor is account-only and restriction row's membershipId is cleared", async () => {
    const db = makeDb([{ userId: null, membershipId: null, role: null }]);
    const svc = new KbAccessService(db as never, makeCache() as never, makeAccess() as never);
    const user = makeUser({ userId: "user-departed", principal: ACCOUNT_ONLY_PRINCIPAL });
    const row = { id: 1, orgId: "org-1", spaceId: null };
    await expect(svc.assertCanViewArticle(user, row)).rejects.toThrow("Article not found");
  });
});
