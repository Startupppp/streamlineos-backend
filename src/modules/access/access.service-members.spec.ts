jest.mock("../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { makeMembershipStateStub } from "../../../test/helpers/membership-state-stub";
import { AccessService } from "./access.service";
import { AccessVersionCache } from "./access-version-cache";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { EntitlementsService } from "./entitlements.service";
import { makeMfaPolicyStub } from "../../../test/helpers/mfa-policy-stub";

describe("AccessService.membersWithPermission", () => {
  function makeQueryChain(result: unknown[]): Record<string, jest.Mock> {
    const p = Promise.resolve(result);
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(),
      where: jest.fn(),
      innerJoin: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      then: jest.fn().mockImplementation(
        (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) => p.then(res, rej),
      ),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    return chain;
  }

  function buildSvc(opts: {
    selectResults?: unknown[][];
    distinctResults?: unknown[][];
    isModuleEnabled?: boolean;
  }): AccessService {
    let sIdx = 0;
    let dIdx = 0;
    const sr = opts.selectResults ?? [];
    const dr = opts.distinctResults ?? [];

    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn().mockImplementation(() => makeQueryChain(sr[sIdx++] ?? [])),
      selectDistinct: jest.fn().mockImplementation(() => makeQueryChain(dr[dIdx++] ?? [])),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
    );

    const cache = {
      cached: jest.fn().mockImplementation(async (_k: string, fn: () => Promise<unknown>) => fn()),
      invalidate: jest.fn().mockResolvedValue(undefined),
      cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
    },
      cachedForOrgWith<T>(o: string, k: string, fn: () => Promise<T>) {
      return this.cached(`${o}:${k}`, fn);
    },
      invalidateForOrg(o: string, k: string) {
      return this.invalidate(`${o}:${k}`);
    },
    };

    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(opts.isModuleEnabled ?? true),
      getModuleMap: jest.fn().mockResolvedValue({}),
      getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    };

    return new AccessService(
      db as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
      makeMfaPolicyStub(),
      new AccessVersionCache(db as unknown as Db),
      makeMembershipStateStub(),
    );
  }

  const PERM = "hr:leaves:approve";

  it("returns [] immediately when the module is disabled", async () => {
    const svc = buildSvc({ isModuleEnabled: false });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([]);
  });

  it("returns [] when no member holds the permission", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [],
      ],
      distinctResults: [
        [],
        [],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([]);
  });

  it("includes org owners regardless of role grants", async () => {
    const svc = buildSvc({
      selectResults: [
        [{ userId: "owner-1", membershipId: 10 }],
        [],
      ],
      distinctResults: [
        [],
        [],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "owner-1", membershipId: 10 }]);
  });

  it("includes members with an explicit role grant via direct role assignment", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [],
      ],
      distinctResults: [
        [{ roleId: 42 }],
        [{ roleId: 42 }],
        [],
        [{ userId: "u-direct", membershipId: 20 }],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "u-direct", membershipId: 20 }]);
  });

  it("includes members who inherit the role via a principal group", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [],
      ],
      distinctResults: [
        [{ roleId: 55 }],
        [{ roleId: 55 }],
        [],
        [],
        [{ userId: "u-group", membershipId: 30 }],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "u-group", membershipId: 30 }]);
  });

  it("includes module owners", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [],
      ],
      distinctResults: [
        [],
        [],
        [{ userId: "u-modowner", membershipId: 40 }],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "u-modowner", membershipId: 40 }]);
  });

  it("excludes users explicitly denied the module", async () => {
    const svc = buildSvc({
      selectResults: [
        [{ userId: "owner-1", membershipId: 10 }],
        [],
        [{ userId: "owner-1" }],
      ],
      distinctResults: [
        [],
        [],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([]);
  });

  it("includes a member whose role uses the ROLE_DEFAULT_PERMISSIONS fallback", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [{ roleId: 77 }],
      ],
      distinctResults: [
        [],
        [],
        [],
        [{ userId: "u-default", membershipId: 50 }],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "u-default", membershipId: 50 }]);
  });

  it("deduplicates a user who appears in both owner rows and role assignment rows", async () => {
    const svc = buildSvc({
      selectResults: [
        [{ userId: "u-dup", membershipId: 60 }],
        [],
      ],
      distinctResults: [
        [{ roleId: 88 }],
        [{ roleId: 88 }],
        [],
        [{ userId: "u-dup", membershipId: 60 }],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("u-dup");
  });
});

describe("AccessService.membersWithPermission — pagination", () => {
  interface CapSvc {
    svc: AccessService;
    cachedMock: jest.Mock;
  }

  function buildCapSvc(pages: {
    data: { userId: string; membershipId: number }[];
    nextCursor: number;
    exhausted: boolean;
  }[]): CapSvc {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
    );

    const cachedMock = jest.fn().mockImplementation(
      async (_key: string, _fn: () => Promise<unknown>) => {
        return pages.shift() ?? { data: [], nextCursor: 0, exhausted: true };
      },
    );

    const cache = {
      cached: cachedMock,
      invalidate: jest.fn().mockResolvedValue(undefined),
      cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
    },
      cachedForOrgWith<T>(o: string, k: string, fn: () => Promise<T>) {
      return this.cached(`${o}:${k}`, fn);
    },
      invalidateForOrg(o: string, k: string) {
      return this.invalidate(`${o}:${k}`);
    },
    };

    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({}),
      getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    };

    return {
      svc: new AccessService(
        db as unknown as Db,
        cache as unknown as CacheService,
        entitlements as unknown as EntitlementsService,
        makeMfaPolicyStub(),
        new AccessVersionCache(db as unknown as Db),
        makeMembershipStateStub(),
      ),
      cachedMock,
    };
  }

  it("loads every page when no explicit limit is supplied", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      userId: `u-${i}`,
      membershipId: i,
    }));
    const { svc, cachedMock } = buildCapSvc([
      { data: firstPage, nextCursor: 100, exhausted: false },
      {
        data: [{ userId: "u-100", membershipId: 100 }],
        nextCursor: 101,
        exhausted: true,
      },
    ]);

    const result = await svc.membersWithPermission(
      "org-1",
      "settings:manage",
    );

    expect(result).toHaveLength(101);
    expect(cachedMock).toHaveBeenCalledTimes(2);
    expect(String(cachedMock.mock.calls[0]?.[0])).toContain(":a0:l100");
    expect(String(cachedMock.mock.calls[1]?.[0])).toContain(":a100:l100");
  });

  it("stops at an explicit caller limit without a silent default cap", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      userId: `u-${i}`,
      membershipId: i,
    }));
    const { svc, cachedMock } = buildCapSvc([
      { data: firstPage, nextCursor: 100, exhausted: false },
    ]);

    const result = await svc.membersWithPermission(
      "org-1",
      "settings:manage",
      { limit: 50 },
    );

    expect(result).toHaveLength(50);
    expect(cachedMock).toHaveBeenCalledTimes(1);
  });
});
