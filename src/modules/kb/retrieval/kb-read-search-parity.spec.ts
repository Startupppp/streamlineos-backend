import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { isPageIndexable } from "./kb-indexing.service";
import { KbPageSearchQueryService } from "./kb-page-search-query.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
import type { KbActorStanding } from "../core/authorization/knowledge-authorization.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG_ID = "org-1";
const AUTHOR_ID = "author-1";
const MEMBER_ID = "member-1";
const OWNER_ID = "owner-1";
const PAGE_PROJECT_ID = 42;
const OUTSIDE_PROJECT_ID = 999;
const GRANTED_SPACE_ID = 7;

const dialect = new PgDialect();

const shape = (node: SQL<unknown>): string =>
  dialect
    .sqlToQuery(node)
    .sql.replace(/\$\d+/g, "?")
    .replace(/\s+/g, " ")
    .trim();

const boundParams = (node: SQL<unknown>): unknown[] => dialect.sqlToQuery(node).params;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: MEMBER_ID,
    orgId: ORG_ID,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

function makeStanding(overrides: Partial<KbActorStanding> = {}): KbActorStanding {
  return {
    orgId: ORG_ID,
    userId: MEMBER_ID,
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [],
    accessibleProjectIds: [],
    permissionsVersion: 1,
    ...overrides,
  };
}

interface Viewer {
  label: string;
  user: CurrentUserContext;
  standing: KbActorStanding;
}

const VIEWERS: Viewer[] = [
  {
    label: "author",
    user: makeUser({ userId: AUTHOR_ID }),
    standing: makeStanding({ userId: AUTHOR_ID }),
  },
  {
    label: "project member (not author)",
    user: makeUser(),
    standing: makeStanding({ accessibleProjectIds: [PAGE_PROJECT_ID] }),
  },
  {
    label: "outside project (member of a different project)",
    user: makeUser(),
    standing: makeStanding({ accessibleProjectIds: [OUTSIDE_PROJECT_ID] }),
  },
  {
    label: "ordinary org member (no project, no space)",
    user: makeUser(),
    standing: makeStanding(),
  },
  {
    label: "space member",
    user: makeUser(),
    standing: makeStanding({ accessibleSpaceIds: [GRANTED_SPACE_ID] }),
  },
  {
    label: "org owner",
    user: makeUser({ userId: OWNER_ID, isOrgOwner: true }),
    standing: makeStanding({ userId: OWNER_ID, membershipId: 9, isOrgOwner: true }),
  },
];

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

function directReadWhere(viewer: Viewer): Promise<SQL<unknown>> {
  const captured: { where?: SQL<unknown> } = {};
  const db = {
    query: {
      kbPages: {
        findFirst: (args: { where: SQL<unknown> }) => {
          captured.where = args.where;
          return Promise.resolve(undefined);
        },
      },
    },
    select: () => emptyQueryChain(),
    selectDistinct: () => emptyQueryChain(),
  };
  const auth = new KnowledgeAuthorizationService(
    db as never,
    { cachedVersioned: jest.fn() } as never,
    { holds: jest.fn(), getPermissionsVersion: jest.fn() } as never,
  );
  jest.spyOn(auth, "resolveStanding").mockResolvedValue(viewer.standing);

  return auth.resolvePageAccess(viewer.user, 7, "view").then(() => {
    if (captured.where === undefined)
      throw new Error(`direct read never reached the page query for ${viewer.label}`);
    return captured.where;
  });
}

const SEARCH_QUERY = { q: "onboarding", limit: 20, facets: false } as const;

async function keywordSearchWhere(viewer: Viewer): Promise<SQL<unknown>> {
  const whereClauses: SQL<unknown>[] = [];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn((clause: SQL<unknown>) => {
      whereClauses.push(clause);
      return chain;
    }),
    orderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  const db = { select: jest.fn().mockReturnValue(chain) };
  const auth = { resolveStanding: jest.fn().mockResolvedValue(viewer.standing) };

  await new KbPageSearchQueryService(db as never, auth as never).search(
    viewer.user,
    SEARCH_QUERY,
  );

  if (whereClauses[0] === undefined)
    throw new Error(`keyword search never issued a query for ${viewer.label}`);
  return whereClauses[0];
}

describe("read/search parity — both paths apply the same visibility scope for the same actor", () => {
  for (const viewer of VIEWERS) {
    describe(`viewer: ${viewer.label}`, () => {
      it("the direct page read carries the canonical view scope for this actor", async () => {
        const acl = buildVisiblePageScope(viewer.standing, "view").predicate;

        const where = await directReadWhere(viewer);

        expect(shape(where)).toContain(shape(acl));
        expect(boundParams(where)).toEqual(expect.arrayContaining(boundParams(acl)));
      });

      it("keyword search carries that identical scope, so a page readable directly is reachable by search", async () => {
        const acl = buildVisiblePageScope(viewer.standing, "view").predicate;

        const where = await keywordSearchWhere(viewer);

        expect(shape(where)).toContain(shape(acl));
        expect(boundParams(where)).toEqual(expect.arrayContaining(boundParams(acl)));
      });

      it("the scope fragment the two paths share is byte-identical, so neither can drift into a looser rule", async () => {
        const acl = shape(buildVisiblePageScope(viewer.standing, "view").predicate);

        const [read, search] = await Promise.all([
          directReadWhere(viewer),
          keywordSearchWhere(viewer),
        ]);

        expect(shape(read)).toContain(acl);
        expect(shape(search)).toContain(acl);
      });
    });
  }

  it("BITE: the containment assertion rejects a WHERE that dropped the scope, so it is not satisfied by any predicate", async () => {
    const viewer = VIEWERS[3];
    const acl = shape(buildVisiblePageScope(viewer.standing, "view").predicate);
    const tenantOnly = shape(
      buildVisiblePageScope(makeStanding({ isOrgOwner: true }), "view").predicate,
    );

    expect(tenantOnly).not.toContain(acl);
    expect(shape(await keywordSearchWhere(viewer))).not.toBe(tenantOnly);
  });

  it("BITE: two actors with different standing get different scopes, so the shared fragment is actor-specific", () => {
    const shapes = VIEWERS.map((viewer) =>
      shape(buildVisiblePageScope(viewer.standing, "view").predicate),
    );

    expect(new Set(shapes).size).toBeGreaterThan(1);
  });

  it("BITE: the project member's scope binds the project id, and the outsider's binds a different one", () => {
    const member = boundParams(
      buildVisiblePageScope(makeStanding({ accessibleProjectIds: [PAGE_PROJECT_ID] }), "view")
        .predicate,
    );
    const outsider = boundParams(
      buildVisiblePageScope(makeStanding({ accessibleProjectIds: [OUTSIDE_PROJECT_ID] }), "view")
        .predicate,
    );

    expect(member).toContain(PAGE_PROJECT_ID);
    expect(member).not.toContain(OUTSIDE_PROJECT_ID);
    expect(outsider).toContain(OUTSIDE_PROJECT_ID);
    expect(outsider).not.toContain(PAGE_PROJECT_ID);
  });
});

describe("read/search parity — the one actor the two paths do not treat alike", () => {
  const roleOnly: Viewer = {
    label: "role holder with no live org membership",
    user: makeUser(),
    standing: makeStanding({ membershipId: null, roleSlugs: ["support-lead"] }),
  };

  it("the direct read refuses a membership-less actor structurally, before the page predicate is ever built", async () => {
    const auth = new KnowledgeAuthorizationService(
      {
        query: {
          kbPages: {
            findFirst: jest.fn(() => {
              throw new Error("the page query must not run for a membership-less actor");
            }),
          },
        },
        select: () => emptyQueryChain(),
        selectDistinct: () => emptyQueryChain(),
      } as never,
      { cachedVersioned: jest.fn() } as never,
      { holds: jest.fn(), getPermissionsVersion: jest.fn() } as never,
    );
    jest.spyOn(auth, "resolveStanding").mockResolvedValue(roleOnly.standing);

    const decision = await auth.resolvePageAccess(roleOnly.user, 7, "view");

    expect(decision.outcome).toBe("denied");
  });

  it("keyword search has no such structural gate, so its only fence for that actor is the grant scope — which it does apply", async () => {
    const acl = buildVisiblePageScope(roleOnly.standing, "view").predicate;

    const where = await keywordSearchWhere(roleOnly);

    expect(shape(where)).toContain(shape(acl));
    expect(shape(where)).toContain("kb_page_grants");
    expect(boundParams(where)).toContain("support-lead");
  });

  it("that scope is not a tenant-only pass-all, so the missing structural gate does not hand the actor the org", async () => {
    const tenantOnly = shape(
      buildVisiblePageScope(makeStanding({ isOrgOwner: true }), "view").predicate,
    );

    expect(shape(await keywordSearchWhere(roleOnly))).not.toBe(tenantOnly);
  });
});

describe("read/search parity — search adds its own fences on top of the shared scope", () => {
  it("keyword search fences soft-deleted pages that the direct read also fences", async () => {
    const where = await keywordSearchWhere(VIEWERS[3]);

    expect(shape(where)).toContain(`"kb_pages"."deleted_at" is null`);
    expect(shape(await directReadWhere(VIEWERS[3]))).toContain(
      `"kb_pages"."deleted_at" is null`,
    );
  });

  it("keyword search binds the caller's own tenant beside the scope, never another org's", async () => {
    const where = await keywordSearchWhere(VIEWERS[3]);

    expect(boundParams(where)).toContain(ORG_ID);
    expect(boundParams(where)).not.toContain("org-2");
  });
});

describe("safety net — indexability is not an access decision", () => {
  it("isPageIndexable admits a private page, so indexing alone can never decide who retrieves it", () => {
    expect(isPageIndexable({ status: "published", deletedAt: null })).toBe(true);
  });

  it("an ordinary member's search is still fenced by a scope narrower than the tenant, so indexability does not widen retrieval", async () => {
    const viewer = VIEWERS[3];

    const searched = shape(await keywordSearchWhere(viewer));

    expect(searched).toContain(`"kb_pages"."visibility" IN ('org', 'public')`);
    expect(searched).toContain(`"kb_pages"."created_by_id" = ?`);
  });

  it("an archived page remains unindexed regardless of visibility — lifecycle gate is preserved", () => {
    expect(isPageIndexable({ status: "archived", deletedAt: null })).toBe(false);
  });

  it("a soft-deleted page remains unindexed — an org whose only pages are deleted makes no embedding call", () => {
    expect(isPageIndexable({ status: "published", deletedAt: new Date() })).toBe(false);
  });
});
