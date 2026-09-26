import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { KnowledgeAuthorizationService } from "./knowledge-authorization.service";
import type { AccessService } from "../../../access/access.service";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

jest.mock("./knowledge-space-scope", () => ({
  resolveRoleSlugs: jest.fn().mockResolvedValue([]),
  computeAccessibleSpaceIds: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../retrieval/kb-project-access.util", () => ({
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
}));

import { computeAccessibleSpaceIds, resolveRoleSlugs } from "./knowledge-space-scope";
import { getAccessibleProjectIds } from "../../retrieval/kb-project-access.util";
import { runWithObservabilityContext } from "../../../../common/observability/observability-context";

const mockedSpaceIds = computeAccessibleSpaceIds as jest.MockedFunction<
  typeof computeAccessibleSpaceIds
>;
const mockedRoleSlugs = resolveRoleSlugs as jest.MockedFunction<
  typeof resolveRoleSlugs
>;
const mockedProjectIds = getAccessibleProjectIds as jest.MockedFunction<
  typeof getAccessibleProjectIds
>;

let requestSequence = 0;

function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  requestSequence += 1;
  return runWithObservabilityContext(
    { correlationId: `correlation-${requestSequence}` },
    fn,
  );
}

function makeUser(over: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "member",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 7, isOrgOwner: false },
    ...over,
  } as unknown as CurrentUserContext;
}

interface Harness {
  service: KnowledgeAuthorizationService;
  findPage: jest.Mock;
  findSpace: jest.Mock;
}

function makeHarness(over: { isAdmin?: boolean; spaceIds?: number[] } = {}): Harness {
  mockedSpaceIds.mockResolvedValue(over.spaceIds ?? []);
  const findPage = jest.fn().mockResolvedValue(undefined);
  const findSpace = jest.fn().mockResolvedValue(undefined);
  const db = {
    query: {
      kbPages: { findFirst: findPage },
      kbSpaces: { findFirst: findSpace },
    },
  };
  const access = {
    holds: jest.fn().mockResolvedValue(over.isAdmin ?? false),
    getPermissionsVersion: jest.fn().mockResolvedValue(3),
  } as unknown as AccessService;
  const cache = {
    cachedVersioned: jest
      .fn()
      .mockImplementation((_ns: unknown, _key: unknown, fn: () => unknown) => fn()),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
  return {
    service: new KnowledgeAuthorizationService(db as never, cache, access),
    findPage,
    findSpace,
  };
}

describe("KnowledgeAuthorizationService.resolvePageAccess — disagreement resolution", () => {
  it("allows an org-visible page in a space the actor cannot reach, so list path and single-read path agree on org-visibility superseding space membership", async () => {
    const { service, findPage } = makeHarness({ spaceIds: [1, 2] });
    findPage.mockResolvedValue({
      id: 5,
      ownerMembershipId: null,
      createdById: "other-user",
      createdByMembershipId: null,
      visibility: "org",
      spaceId: 99,
      projectId: null,
    });

    const decision = await inRequest(() => service.resolvePageAccess(makeUser(), 5, "view"));

    expect(decision.outcome).toBe("allowed");
  });

  it("BITE: the single-read assertion still denies a page genuinely outside the actor's scope, so the positive above is not vacuous", async () => {
    const { service } = makeHarness({ spaceIds: [1, 2] });

    const decision = await inRequest(() => service.resolvePageAccess(makeUser(), 5, "view"));

    expect(decision.outcome).toBe("notFound");
  });

  it("passes the restriction branch inside the scope predicate to the page query for non-admin actors, matching the list predicate so restriction-gated pages are denied at the SQL level", async () => {
    let capturedWhere: unknown;
    const findPage = jest.fn().mockImplementation((opts: { where: unknown }) => {
      capturedWhere = opts.where;
      return Promise.resolve(undefined);
    });
    const db = { query: { kbPages: { findFirst: findPage }, kbSpaces: { findFirst: jest.fn() } } };
    const access = {
      holds: jest.fn().mockResolvedValue(false),
      getPermissionsVersion: jest.fn().mockResolvedValue(3),
    } as unknown as AccessService;
    const cache = {
      cachedVersioned: jest.fn().mockImplementation((_ns: unknown, _key: unknown, fn: () => unknown) => fn()),
      invalidateNamespace: jest.fn(),
    } as unknown as CacheService;
    const service = new KnowledgeAuthorizationService(db as never, cache, access);

    await inRequest(() => service.resolvePageAccess(makeUser(), 5, "view"));

    const dialect = new PgDialect();
    const { sql: querySql } = dialect.sqlToQuery(capturedWhere as Parameters<typeof dialect.sqlToQuery>[0]);
    expect(querySql).toContain("kb_page_restrictions");
  });

  it("BITE: an admin actor does not get a restriction clause because the admin fast path bypasses restriction checks", async () => {
    let capturedWhere: unknown;
    const findPage = jest.fn().mockImplementation((opts: { where: unknown }) => {
      capturedWhere = opts.where;
      return Promise.resolve(undefined);
    });
    const db = { query: { kbPages: { findFirst: findPage }, kbSpaces: { findFirst: jest.fn() } } };
    const access = {
      holds: jest.fn().mockResolvedValue(true),
      getPermissionsVersion: jest.fn().mockResolvedValue(3),
    } as unknown as AccessService;
    const cache = {
      cachedVersioned: jest.fn().mockImplementation((_ns: unknown, _key: unknown, fn: () => unknown) => fn()),
      invalidateNamespace: jest.fn(),
    } as unknown as CacheService;
    const service = new KnowledgeAuthorizationService(db as never, cache, access);

    await inRequest(() => service.resolvePageAccess(makeUser(), 5, "view"));

    const dialect = new PgDialect();
    const { sql: querySql } = dialect.sqlToQuery(capturedWhere as Parameters<typeof dialect.sqlToQuery>[0]);
    expect(querySql).not.toContain("kb_page_restrictions");
  });
});

describe("KnowledgeAuthorizationService.resolvePageAccess", () => {
  it("reports a page it cannot reach as not found, never as denied, so a hidden page is indistinguishable from a missing one", async () => {
    const { service } = makeHarness();

    const decision = await service.resolvePageAccess(makeUser(), 5, "view");

    expect(decision.outcome).toBe("notFound");
  });

  it("denies an actor holding no membership before it ever looks a record up", async () => {
    const { service, findPage } = makeHarness();
    const stranger = makeUser({ principal: undefined });

    const decision = await service.resolvePageAccess(stranger, 5, "view");

    expect(decision.outcome).toBe("denied");
    expect(findPage).not.toHaveBeenCalled();
  });

  it("still serves an org owner who carries no membership row", async () => {
    const { service, findPage } = makeHarness();
    findPage.mockResolvedValue({
      id: 5,
      ownerMembershipId: null,
      createdById: "someone-else",
      createdByMembershipId: null,
      visibility: "org",
      spaceId: null,
      projectId: null,
    });
    const owner = makeUser({ principal: undefined, isOrgOwner: true });

    const decision = await service.resolvePageAccess(owner, 5, "view");

    expect(decision.outcome).toBe("allowed");
  });

  it("attributes a reachable page the actor owns to the owner route", async () => {
    const { service, findPage } = makeHarness();
    findPage.mockResolvedValue({
      id: 5,
      ownerMembershipId: 7,
      createdById: "someone-else",
      createdByMembershipId: null,
      visibility: "private",
      spaceId: null,
      projectId: null,
    });

    const decision = await service.resolvePageAccess(makeUser(), 5, "view");

    expect(decision).toEqual({
      outcome: "allowed",
      scope: { orgId: "o1", pageId: 5, action: "view", via: "owner" },
    });
  });

  it("attributes a page reachable only through an explicit grant to the grant route", async () => {
    const { service, findPage } = makeHarness();
    findPage.mockResolvedValue({
      id: 5,
      ownerMembershipId: 99,
      createdById: "someone-else",
      createdByMembershipId: 99,
      visibility: "private",
      spaceId: null,
      projectId: null,
    });

    const decision = await service.resolvePageAccess(makeUser(), 5, "view");

    expect(decision.outcome).toBe("allowed");
    expect(decision.outcome === "allowed" && decision.scope.via).toBe("grant");
  });

  it("carries the requested action into the scope so an edit is never satisfied by a view lookup", async () => {
    const { service, findPage } = makeHarness();
    findPage.mockResolvedValue({
      id: 5,
      ownerMembershipId: 7,
      createdById: "u1",
      createdByMembershipId: 7,
      visibility: "private",
      spaceId: null,
      projectId: null,
    });

    const decision = await service.resolvePageAccess(makeUser(), 5, "edit");

    expect(decision.outcome === "allowed" && decision.scope.action).toBe("edit");
  });
});

describe("KnowledgeAuthorizationService.assertPageAccess", () => {
  it("raises a not-found rather than a forbidden for a hidden page", async () => {
    const { service } = makeHarness();

    await expect(service.assertPageAccess(makeUser(), 5, "view")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("raises a forbidden only for an actor with no standing in the tenant", async () => {
    const { service } = makeHarness();

    await expect(
      service.assertPageAccess(makeUser({ principal: undefined }), 5, "view"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("KnowledgeAuthorizationService — fail-closed cache behavior", () => {
  it("propagates cache errors so access is never silently granted when the cache is unavailable", async () => {
    const cacheError = new Error("Redis connection refused");
    mockedSpaceIds.mockRejectedValue(cacheError);
    const findPage = jest.fn();
    const db = { query: { kbPages: { findFirst: findPage }, kbSpaces: { findFirst: jest.fn() } } };
    const access = {
      holds: jest.fn().mockResolvedValue(false),
      getPermissionsVersion: jest.fn().mockResolvedValue(3),
    } as unknown as AccessService;
    const cache = {
      cachedVersioned: jest
        .fn()
        .mockImplementation((_ns: unknown, _key: unknown, fn: () => unknown) => fn()),
      invalidateNamespace: jest.fn(),
    } as unknown as CacheService;

    const service = new KnowledgeAuthorizationService(db as never, cache, access);

    await expect(service.resolvePageAccess(makeUser(), 5, "view")).rejects.toThrow(cacheError);
    expect(findPage).not.toHaveBeenCalled();
  });

  it("never returns an allowed decision when space-scope resolution throws", async () => {
    const cacheError = new Error("cache unavailable");
    mockedSpaceIds.mockRejectedValue(cacheError);
    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({
            id: 5,
            ownerMembershipId: 7,
            createdById: "u1",
            createdByMembershipId: 7,
            visibility: "org",
            spaceId: null,
            projectId: null,
          }),
        },
        kbSpaces: { findFirst: jest.fn() },
      },
    };
    const access = {
      holds: jest.fn().mockResolvedValue(false),
      getPermissionsVersion: jest.fn().mockResolvedValue(3),
    } as unknown as AccessService;
    const cache = {
      cachedVersioned: jest
        .fn()
        .mockImplementation((_ns: unknown, _key: unknown, fn: () => unknown) => fn()),
      invalidateNamespace: jest.fn(),
    } as unknown as CacheService;

    const service = new KnowledgeAuthorizationService(db as never, cache, access);
    const result = await service.resolvePageAccess(makeUser(), 5, "view").catch((e: unknown) => e);

    expect(result).not.toMatchObject({ outcome: "allowed" });
  });
});

describe("KnowledgeAuthorizationService.resolveSpaceAccess", () => {
  it("reports a space outside the actor's reach as not found", async () => {
    const { service, findSpace } = makeHarness({ spaceIds: [1] });
    findSpace.mockResolvedValue({ id: 2, createdByMembershipId: 99 });

    const decision = await service.resolveSpaceAccess(makeUser(), 2, "view");

    expect(decision.outcome).toBe("notFound");
  });

  it("admits a space the actor belongs to", async () => {
    const { service, findSpace } = makeHarness({ spaceIds: [2] });
    findSpace.mockResolvedValue({ id: 2, createdByMembershipId: 99 });

    const decision = await service.resolveSpaceAccess(makeUser(), 2, "view");

    expect(decision.outcome).toBe("allowed");
  });

  it("refuses to let mere space membership authorize managing that space", async () => {
    const { service, findSpace } = makeHarness({ spaceIds: [2] });
    findSpace.mockResolvedValue({ id: 2, createdByMembershipId: 99 });

    const decision = await service.resolveSpaceAccess(makeUser(), 2, "manage");

    expect(decision.outcome).toBe("notFound");
  });

  it("lets the space creator manage it", async () => {
    const { service, findSpace } = makeHarness({ spaceIds: [2] });
    findSpace.mockResolvedValue({ id: 2, createdByMembershipId: 7 });

    const decision = await service.resolveSpaceAccess(makeUser(), 2, "manage");

    expect(decision.outcome).toBe("allowed");
  });

  it("lets a knowledge admin manage a space they never joined", async () => {
    const { service, findSpace } = makeHarness({ isAdmin: true, spaceIds: [] });
    findSpace.mockResolvedValue({ id: 2, createdByMembershipId: 99 });

    const decision = await service.resolveSpaceAccess(makeUser(), 2, "manage");

    expect(decision.outcome).toBe("allowed");
    expect(decision.outcome === "allowed" && decision.scope.via).toBe("admin");
  });

  it("reports a deleted or absent space as not found without consulting reachability", async () => {
    const { service, findSpace } = makeHarness({ spaceIds: [2] });
    findSpace.mockResolvedValue(undefined);

    const decision = await service.resolveSpaceAccess(makeUser(), 2, "view");

    expect(decision.outcome).toBe("notFound");
  });
});

describe("KnowledgeAuthorizationService.articleRestrictionPredicate", () => {
  it("returns null for an org owner so restriction rows never gate an admin", async () => {
    const { service } = makeHarness({ isAdmin: false });
    const owner = makeUser({ isOrgOwner: true, principal: undefined });

    const result = await inRequest(() => service.articleRestrictionPredicate(owner));

    expect(result).toBeNull();
  });

  it("returns null for a knowledge admin so restriction rows never gate an admin", async () => {
    const { service } = makeHarness({ isAdmin: true });

    const result = await inRequest(() => service.articleRestrictionPredicate(makeUser()));

    expect(result).toBeNull();
  });

  it("returns a SQL predicate for a non-admin member so restriction rows can filter the query", async () => {
    const { service } = makeHarness({ isAdmin: false });

    const result = await inRequest(() => service.articleRestrictionPredicate(makeUser()));

    expect(result).not.toBeNull();
  });

  it("binds the actor's org in the returned predicate so cross-tenant restriction rows cannot match", async () => {
    const { service } = makeHarness({ isAdmin: false });
    const user = makeUser({ orgId: "specific-org" });
    const dialect = new PgDialect();

    const result = await inRequest(() => service.articleRestrictionPredicate(user));

    expect(result).not.toBeNull();
    const { params } = dialect.sqlToQuery(result!);
    expect(params).toContain("specific-org");
  });
});

describe("KnowledgeAuthorizationService.resolveStanding request memoization", () => {
  beforeEach(() => {
    mockedRoleSlugs.mockClear();
    mockedProjectIds.mockClear();
  });

  it("resolves standing once when three predicate sites share a request, because paying per call site is the read-cost regression this box records", async () => {
    const { service } = makeHarness();
    const user = makeUser();

    await inRequest(async () => {
      await service.visiblePagePredicate(user, "view");
      await service.visiblePagePredicate(user, "edit");
      await service.resolvePageAccess(user, 5, "view");
    });

    expect(mockedRoleSlugs).toHaveBeenCalledTimes(1);
    expect(mockedProjectIds).toHaveBeenCalledTimes(1);
  });

  it("resolves standing again in the next request, because a memo that outlives its request outlives a revocation", async () => {
    const { service } = makeHarness();
    const user = makeUser();

    await inRequest(() => service.resolveStanding(user));
    await inRequest(() => service.resolveStanding(user));

    expect(mockedRoleSlugs).toHaveBeenCalledTimes(2);
    expect(mockedProjectIds).toHaveBeenCalledTimes(2);
  });

  it("keeps two actors apart inside one request, because an unkeyed memo would hand one tenant the other's standing", async () => {
    const { service } = makeHarness();
    const mine = makeUser({ orgId: "o1", userId: "u1" });
    const theirs = makeUser({ orgId: "o2", userId: "u2" });

    const [first, second] = await inRequest(() =>
      Promise.all([
        service.resolveStanding(mine),
        service.resolveStanding(theirs),
      ]),
    );

    expect(mockedRoleSlugs).toHaveBeenCalledTimes(2);
    expect(first.orgId).toBe("o1");
    expect(second.orgId).toBe("o2");
  });

  it("resolves fresh outside a request, because background sweeps run with no ambient context", async () => {
    const { service } = makeHarness();
    const user = makeUser();

    await service.resolveStanding(user);
    await service.resolveStanding(user);

    expect(mockedRoleSlugs).toHaveBeenCalledTimes(2);
    expect(mockedProjectIds).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a rejected resolution, because one transient failure must not poison the rest of the request", async () => {
    const { service } = makeHarness();
    const user = makeUser();
    mockedProjectIds.mockRejectedValueOnce(new Error("statement timeout"));

    await inRequest(async () => {
      await expect(service.resolveStanding(user)).rejects.toThrow(
        "statement timeout",
      );
      await expect(service.resolveStanding(user)).resolves.toMatchObject({
        orgId: "o1",
      });
    });

    expect(mockedProjectIds).toHaveBeenCalledTimes(2);
  });
});
