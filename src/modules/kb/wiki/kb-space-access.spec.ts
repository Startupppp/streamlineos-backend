import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbSpacesService } from "./kb-spaces.service";
import type { KbAccessService } from "../core/kb-access.service";
import type { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead } from "../../access/scoped-read";

const ORG_A = "org-a";
const ORG_B = "org-b";
const SPACE_ID = 42;
const DEFAULT_LIMIT = 20;

function makeUser(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: "user-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
  };
}

function makeQueryOne(returns: object | undefined) {
  return jest.fn().mockResolvedValue(returns);
}

function makeService(
  spaceLookupResult: object | undefined,
  accessibleIds: number[],
): { svc: KbSpacesService } {
  const db = {
    query: {
      kbSpaces: { findFirst: makeQueryOne(spaceLookupResult) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
          groupBy: jest.fn().mockResolvedValue([]),
          limit: jest.fn().mockResolvedValue([]),
        }),
        leftJoin: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: SPACE_ID }]),
        }),
      }),
    }),
    transaction: jest.fn().mockImplementation((fn: (tx: object) => Promise<unknown>) => fn({})),
  } as unknown as Db;

  const access = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue(accessibleIds),
    assertSpaceAccessible: jest.fn().mockImplementation(() => {
      if (!accessibleIds.includes(SPACE_ID)) {
        return Promise.reject(new NotFoundException("Space not found"));
      }
      return Promise.resolve();
    }),
    invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbAccessService;

  const authz = {
    visiblePagePredicate: jest.fn().mockResolvedValue(undefined),
    resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: accessibleIds }),
    invalidateSpaceScope: jest.fn().mockResolvedValue(undefined),
    assertSpaceAccess: jest.fn().mockImplementation(() => {
      if (!accessibleIds.includes(SPACE_ID)) {
        return Promise.reject(new NotFoundException("Space not found"));
      }
      return Promise.resolve();
    }),
   resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }) } as unknown as KnowledgeAuthorizationService;

  const indexing = {} as unknown as KbIndexingService;

  return { svc: new KbSpacesService(db, indexing, authz) };
}

describe("KbSpacesService — cross-tenant and access isolation", () => {
  it("returns 404 for a space in another org (cross-tenant miss is indistinguishable from not-found)", async () => {
    const { svc } = makeService(undefined, []);

    await expect(svc.get(makeUser(ORG_A), SPACE_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns 404 for a space in the same org the caller cannot access (indistinguishable from cross-tenant miss)", async () => {
    const spaceRow = { id: SPACE_ID, orgId: ORG_A, deletedAt: null };
    const { svc } = makeService(spaceRow, []);

    await expect(svc.get(makeUser(ORG_A), SPACE_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns the space when it is accessible (positive control)", async () => {
    const spaceRow = { id: SPACE_ID, orgId: ORG_A, deletedAt: null, name: "Engineering" };
    const { svc } = makeService(spaceRow, [SPACE_ID]);

    const result = await svc.get(makeUser(ORG_A), SPACE_ID);

    expect(result).toMatchObject({ id: SPACE_ID, name: "Engineering" });
  });

  it("cross-tenant and in-org-inaccessible both throw NotFoundException with the same message", async () => {
    const crossTenant = makeService(undefined, []);
    const inOrgInaccessible = makeService({ id: SPACE_ID, orgId: ORG_A, deletedAt: null }, []);

    const crossTenantError = await crossTenant.svc.get(makeUser(ORG_A), SPACE_ID).catch((e) => e);
    const inOrgError = await inOrgInaccessible.svc.get(makeUser(ORG_A), SPACE_ID).catch((e) => e);

    expect(crossTenantError).toBeInstanceOf(NotFoundException);
    expect(inOrgError).toBeInstanceOf(NotFoundException);
    expect((crossTenantError as NotFoundException).message).toBe(
      (inOrgError as NotFoundException).message,
    );
  });
});

describe("KbSpacesService — archive and restore", () => {
  it("archive sets archivedAt and returns success", async () => {
    const spaceRow = { id: SPACE_ID, orgId: ORG_A, deletedAt: null };
    const { svc } = makeService(spaceRow, [SPACE_ID]);

    const result = await svc.archive(ORG_A, SPACE_ID);

    expect(result).toEqual({ success: true });
  });

  it("restore returns success even when space is already restored (idempotent)", async () => {
    const spaceRow = { id: SPACE_ID, orgId: ORG_A, deletedAt: null, archivedAt: null };
    const { svc } = makeService(spaceRow, [SPACE_ID]);

    const first = await svc.restore(ORG_A, SPACE_ID);
    const second = await svc.restore(ORG_A, SPACE_ID);

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
  });

  it("archive then restore leaves the space reachable", async () => {
    const spaceRow = { id: SPACE_ID, orgId: ORG_A, deletedAt: null };
    const { svc } = makeService(spaceRow, [SPACE_ID]);

    await svc.archive(ORG_A, SPACE_ID);
    const result = await svc.restore(ORG_A, SPACE_ID);

    expect(result).toEqual({ success: true });
  });

  it("archive on a space in another org is 404", async () => {
    const { svc } = makeService(undefined, []);

    await expect(svc.archive(ORG_B, SPACE_ID)).rejects.toThrow(NotFoundException);
  });
});

describe("KbSpacesService — page list is cursor-based", () => {
  it("list returns empty cursor page when no accessible spaces exist", async () => {
    const { svc } = makeService(undefined, []);
    const scope = ScopedRead.of(ORG_A, "u-1", "all");

    const result = await svc.list(
      makeUser(ORG_A),
      scope,
      { limit: DEFAULT_LIMIT },
    );

    expect(result.data).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("list returns a cursor page with pagination shape", async () => {
    const scope = ScopedRead.of(ORG_A, "u-1", "all");
    const { svc } = makeService({ id: SPACE_ID, orgId: ORG_A, deletedAt: null }, [SPACE_ID]);

    const result = await svc.list(makeUser(ORG_A), scope, { limit: DEFAULT_LIMIT });

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
    expect(result.pagination).toHaveProperty("hasMore");
    expect(result.pagination).toHaveProperty("nextCursor");
  });
});

describe("KbSpacesService — space access for move operations (authorization contract)", () => {
  it("assertSpaceAccessible rejects when target space is not in accessible ids (denies move target)", async () => {
    const spaceRow = { id: SPACE_ID, orgId: ORG_A, deletedAt: null };
    const { svc } = makeService(spaceRow, []);

    await expect(svc.get(makeUser(ORG_A), SPACE_ID)).rejects.toThrow(NotFoundException);
  });

  it("assertSpaceAccessible resolves when target space is accessible (allows move target)", async () => {
    const spaceRow = { id: SPACE_ID, orgId: ORG_A, deletedAt: null, name: "Target" };
    const { svc } = makeService(spaceRow, [SPACE_ID]);

    await expect(svc.get(makeUser(ORG_A), SPACE_ID)).resolves.toMatchObject({ id: SPACE_ID });
  });

  it("assertSpaceAccessible rejects when source space is not accessible (denies move source)", async () => {
    const SOURCE_SPACE_ID = 99;
    const spaceRow = { id: SOURCE_SPACE_ID, orgId: ORG_A, deletedAt: null };
    const db = {
      query: {
        kbSpaces: { findFirst: jest.fn().mockResolvedValue(spaceRow) },
      },
    } as unknown as Db;

    const access = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([]),
      assertSpaceAccessible: jest.fn().mockRejectedValue(new NotFoundException("Space not found")),
      invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined),
    } as unknown as KbAccessService;

    const svc = new KbSpacesService(
      db,
      {} as unknown as KbIndexingService,
      { visiblePagePredicate: jest.fn().mockResolvedValue(undefined), resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [] }), invalidateSpaceScope: jest.fn().mockResolvedValue(undefined), assertSpaceAccess: jest.fn().mockRejectedValue(new NotFoundException("Space not found")),  resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }) } as unknown as KnowledgeAuthorizationService);

    await expect(svc.get(makeUser(ORG_A), SOURCE_SPACE_ID)).rejects.toThrow(NotFoundException);
  });

  it("get allows access when both source and target are accessible (move control)", async () => {
    const SOURCE_SPACE_ID = 99;
    const TARGET_SPACE_ID = 100;
    const sourceRow = { id: SOURCE_SPACE_ID, orgId: ORG_A, deletedAt: null, name: "Source" };
    const targetRow = { id: TARGET_SPACE_ID, orgId: ORG_A, deletedAt: null, name: "Target" };

    function makeGetService(spaceRow: object, accessibleIds: number[]) {
      const innerDb = {
        query: {
          kbSpaces: { findFirst: jest.fn().mockResolvedValue(spaceRow) },
        },
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue(
              Object.assign(Promise.resolve([{ count: 0 }]), {
                limit: jest.fn().mockResolvedValue([]),
              }),
            ),
          }),
        }),
      } as unknown as Db;
      const innerAccess = {
        getAccessibleSpaceIds: jest.fn().mockResolvedValue(accessibleIds),
        assertSpaceAccessible: jest.fn().mockResolvedValue(undefined),
        invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined),
      } as unknown as KbAccessService;
      return new KbSpacesService(
        innerDb,
        {} as unknown as KbIndexingService,
        { visiblePagePredicate: jest.fn().mockResolvedValue(undefined), resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [] }), invalidateSpaceScope: jest.fn().mockResolvedValue(undefined), assertSpaceAccess: jest.fn().mockResolvedValue(undefined),  resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }) } as unknown as KnowledgeAuthorizationService);
    }

    const sourceSvc = makeGetService(sourceRow, [SOURCE_SPACE_ID, TARGET_SPACE_ID]);
    const targetSvc = makeGetService(targetRow, [SOURCE_SPACE_ID, TARGET_SPACE_ID]);

    await expect(sourceSvc.get(makeUser(ORG_A), SOURCE_SPACE_ID)).resolves.toMatchObject({ id: SOURCE_SPACE_ID });
    await expect(targetSvc.get(makeUser(ORG_A), TARGET_SPACE_ID)).resolves.toMatchObject({ id: TARGET_SPACE_ID });
  });
});

describe("KbSpacesService — page counts exclude pages the caller cannot see", () => {
  it("list page count is derived from visiblePagePredicate applied by the server (not client)", async () => {
    const spaceRow = {
      id: SPACE_ID,
      orgId: ORG_A,
      deletedAt: null,
      updatedAt: new Date(),
      name: "S",
      slug: "s",
      audience: "internal",
      icon: null,
      isPublicHelpCenter: false,
      createdAt: new Date(),
      archivedAt: null,
    };

    const db = {
      query: { kbSpaces: { findFirst: jest.fn() } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([spaceRow]),
            }),
            groupBy: jest.fn().mockResolvedValue([{ spaceId: SPACE_ID, count: 3 }]),
          }),
          leftJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue([spaceRow]),
                }),
              }),
            }),
          }),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              groupBy: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    } as unknown as Db;

    const access = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([SPACE_ID]),
      assertSpaceAccessible: jest.fn().mockResolvedValue(undefined),
      invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined),
    } as unknown as KbAccessService;

    const calledWithPredicate = jest.fn().mockResolvedValue(undefined);
    const authz = {
      visiblePagePredicate: calledWithPredicate,
     resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [SPACE_ID], accessibleProjectIds: [], roleSlugs: [], membershipId: 1 }), invalidateSpaceScope: jest.fn().mockResolvedValue(undefined), assertSpaceAccess: jest.fn().mockResolvedValue(undefined), resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }) } as unknown as KnowledgeAuthorizationService;

    const svc = new KbSpacesService(db, {} as unknown as KbIndexingService, authz);
    const scope = ScopedRead.of(ORG_A, "u-1", "all");

    await svc.list(makeUser(ORG_A), scope, { limit: DEFAULT_LIMIT });

    expect(calledWithPredicate).toHaveBeenCalledTimes(1);
  });
});
