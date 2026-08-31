import { Test } from "@nestjs/testing";
import { ModuleAccessRosterService } from "../module-access-roster.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-actor",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: true,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
    ...overrides,
  };
}

function makeChain(rows: unknown[]) {
  const resolved = Promise.resolve(rows);
  const limitFn = jest.fn().mockResolvedValue(rows);
  const thenable: Record<string, unknown> = {
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    limit: limitFn,
    orderBy: jest.fn(),
    where: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    from: jest.fn(),
  };
  (thenable.orderBy as jest.Mock).mockReturnValue(thenable);
  (thenable.where as jest.Mock).mockReturnValue(thenable);
  (thenable.innerJoin as jest.Mock).mockReturnValue(thenable);
  (thenable.leftJoin as jest.Mock).mockReturnValue(thenable);
  (thenable.from as jest.Mock).mockReturnValue(thenable);
  return thenable;
}

function makePassthroughCache() {
  return {
    cached: jest.fn().mockImplementation(
      (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
    ),
    invalidate: jest.fn(),
  };
}

describe("ModuleAccessRosterService — keyset pagination", () => {
  describe("fetchMembers via listMembers", () => {
    let service: ModuleAccessRosterService;
    let mockDb: { select: jest.Mock; selectDistinct: jest.Mock; query: Record<string, unknown> };

    beforeEach(async () => {
      mockDb = {
        select: jest.fn(),
        selectDistinct: jest.fn(),
        query: {
          organizationMembers: { findFirst: jest.fn() },
          roles: { findFirst: jest.fn() },
        },
      };
      const module = await Test.createTestingModule({
        providers: [
          ModuleAccessRosterService,
          { provide: DRIZZLE, useValue: mockDb },
          { provide: CacheService, useValue: makePassthroughCache() },
          {
            provide: AccessService,
            useValue: {
              isModuleEnabled: jest.fn().mockResolvedValue(true),
              getPermissionsVersion: jest.fn().mockResolvedValue(1),
              resolveUserPermissions: jest.fn().mockResolvedValue(
                new Map([["hr:access:view", "all"]]),
              ),
            },
          },
        ],
      }).compile();
      service = module.get(ModuleAccessRosterService);
    });

    it("page-1 sentinel drives nextCursor; page-2 contains no duplicates and no skipped ids", async () => {
      const moduleRoleRows = [{ id: 10 }];
      const page1GroupRows = [
        { membershipId: 1, groupId: 10, groupName: "HR Staff" },
        { membershipId: 2, groupId: 10, groupName: "HR Staff" },
        { membershipId: 3, groupId: 10, groupName: "HR Staff" },
      ];
      const page2GroupRows = [
        { membershipId: 4, groupId: 10, groupName: "HR Staff" },
        { membershipId: 5, groupId: 10, groupName: "HR Staff" },
      ];
      const page1MemberRows = [
        { membershipId: 1, userId: "u1", name: "Alpha", email: "a@x.com", image: null },
        { membershipId: 2, userId: "u2", name: "Beta",  email: "b@x.com", image: null },
        { membershipId: 3, userId: "u3", name: "Gamma", email: "c@x.com", image: null },
        { membershipId: 4, userId: "u4", name: "Delta", email: "d@x.com", image: null },
      ];
      const page2MemberRows = [
        { membershipId: 4, userId: "u4", name: "Delta",   email: "d@x.com", image: null },
        { membershipId: 5, userId: "u5", name: "Epsilon",  email: "e@x.com", image: null },
      ];

      let selectCall = 0;
      let selectDistinctCall = 0;

      mockDb.select.mockImplementation(() => {
        selectCall++;
        if (selectCall === 1 || selectCall === 3) return makeChain(moduleRoleRows);
        if (selectCall === 2) return makeChain(page1GroupRows);
        return makeChain(page2GroupRows);
      });
      mockDb.selectDistinct.mockImplementation(() => {
        selectDistinctCall++;
        return selectDistinctCall === 1 ? makeChain(page1MemberRows) : makeChain(page2MemberRows);
      });

      const page1 = await service.listMembers(makeActor(), "hr", {
        pageSize: 3,
        cursor: undefined,
      });

      expect(page1.data.map((m) => m.membershipId)).toEqual([1, 2, 3]);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe(3);
      expect(page1.nextCursor).not.toBeUndefined();

      const page2 = await service.listMembers(makeActor(), "hr", {
        pageSize: 3,
        cursor: page1.nextCursor ?? undefined,
      });

      expect(page2.data.map((m) => m.membershipId)).toEqual([4, 5]);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();
      expect(page2.nextCursor).not.toBeUndefined();

      const allIds = [
        ...page1.data.map((m) => m.membershipId),
        ...page2.data.map((m) => m.membershipId),
      ];
      expect(new Set(allIds).size).toBe(allIds.length);
      expect(allIds).toEqual([1, 2, 3, 4, 5]);
    });

    it("last page returns nextCursor: null (not undefined) and hasMore: false", async () => {
      const memberRows = [
        { membershipId: 1, userId: "u1", name: "Alpha", email: "a@x.com", image: null },
        { membershipId: 2, userId: "u2", name: "Beta",  email: "b@x.com", image: null },
      ];
      const groupRows = [
        { membershipId: 1, groupId: 10, groupName: "HR Staff" },
        { membershipId: 2, groupId: 10, groupName: "HR Staff" },
      ];

      mockDb.select
        .mockReturnValueOnce(makeChain([{ id: 10 }]))
        .mockReturnValueOnce(makeChain(groupRows));
      mockDb.selectDistinct.mockReturnValueOnce(makeChain(memberRows));

      const page = await service.listMembers(makeActor(), "hr", {
        pageSize: 5,
        cursor: undefined,
      });

      expect(page.nextCursor).toBeNull();
      expect(page.nextCursor).not.toBeUndefined();
      expect(page.hasMore).toBe(false);
      expect(page.data).toHaveLength(2);
    });

    it("empty module returns nextCursor: null (not undefined)", async () => {
      mockDb.select.mockReturnValueOnce(makeChain([]));

      const page = await service.listMembers(makeActor(), "hr", {
        pageSize: 20,
        cursor: undefined,
      });

      expect(page.nextCursor).toBeNull();
      expect(page.nextCursor).not.toBeUndefined();
      expect(page.data).toHaveLength(0);
      expect(page.hasMore).toBe(false);
    });
  });

  describe("listMemberCandidates keyset pagination", () => {
    let service: ModuleAccessRosterService;
    let mockDb: { select: jest.Mock; selectDistinct: jest.Mock; query: Record<string, unknown> };

    beforeEach(async () => {
      mockDb = {
        select: jest.fn(),
        selectDistinct: jest.fn(),
        query: {
          organizationMembers: { findFirst: jest.fn() },
          roles: { findFirst: jest.fn() },
        },
      };
      const module = await Test.createTestingModule({
        providers: [
          ModuleAccessRosterService,
          { provide: DRIZZLE, useValue: mockDb },
          { provide: CacheService, useValue: makePassthroughCache() },
          {
            provide: AccessService,
            useValue: {
              isModuleEnabled: jest.fn().mockResolvedValue(true),
              getPermissionsVersion: jest.fn().mockResolvedValue(1),
              resolveUserPermissions: jest.fn().mockResolvedValue(
                new Map([["hr:access:manage", "all"]]),
              ),
            },
          },
        ],
      }).compile();
      service = module.get(ModuleAccessRosterService);
    });

    it("last page returns nextCursor: null (not undefined)", async () => {
      const candidateRows = [
        { membershipId: 7, userId: "u7", name: "Alice", email: "alice@x.com", image: null },
        { membershipId: 8, userId: "u8", name: "Bob",   email: "bob@x.com",   image: null },
      ];

      mockDb.select
        .mockReturnValueOnce(makeChain([]))
        .mockReturnValueOnce(makeChain(candidateRows));

      const result = await service.listMemberCandidates(makeActor(), "hr", {
        pageSize: 10,
        search: "",
        excludeAssigned: false,
      });

      expect(result.nextCursor).toBeNull();
      expect(result.nextCursor).not.toBeUndefined();
      expect(result.hasMore).toBe(false);
      expect(result.data).toHaveLength(2);
    });

    it("page-1 sentinel sets nextCursor; page-2 has no duplicates", async () => {
      const page1Rows = [
        { membershipId: 1, userId: "u1", name: "Alpha", email: "a@x.com", image: null },
        { membershipId: 2, userId: "u2", name: "Beta",  email: "b@x.com", image: null },
        { membershipId: 3, userId: "u3", name: "Gamma", email: "c@x.com", image: null },
        { membershipId: 4, userId: "u4", name: "Delta", email: "d@x.com", image: null },
      ];
      const page2Rows = [
        { membershipId: 4, userId: "u4", name: "Delta", email: "d@x.com", image: null },
        { membershipId: 5, userId: "u5", name: "Echo",  email: "e@x.com", image: null },
      ];

      mockDb.select
        .mockReturnValueOnce(makeChain([]))
        .mockReturnValueOnce(makeChain(page1Rows))
        .mockReturnValueOnce(makeChain([]))
        .mockReturnValueOnce(makeChain(page2Rows));

      const r1 = await service.listMemberCandidates(makeActor(), "hr", {
        pageSize: 3,
        search: "",
        excludeAssigned: false,
        cursor: undefined,
      });

      expect(r1.data.length).toBe(3);
      expect(r1.hasMore).toBe(true);
      expect(r1.nextCursor).toBe(3);

      const r2 = await service.listMemberCandidates(makeActor(), "hr", {
        pageSize: 3,
        search: "",
        excludeAssigned: false,
        cursor: r1.nextCursor ?? undefined,
      });

      expect(r2.data.length).toBe(2);
      expect(r2.hasMore).toBe(false);
      expect(r2.nextCursor).toBeNull();

      const allUserIds = [
        ...r1.data.map((c) => c.userId),
        ...r2.data.map((c) => c.userId),
      ];
      expect(new Set(allUserIds).size).toBe(allUserIds.length);
    });
  });
});
