import { ForbiddenException, NotFoundException } from "@nestjs/common";
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

import { computeAccessibleSpaceIds } from "./knowledge-space-scope";

const mockedSpaceIds = computeAccessibleSpaceIds as jest.MockedFunction<
  typeof computeAccessibleSpaceIds
>;

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
