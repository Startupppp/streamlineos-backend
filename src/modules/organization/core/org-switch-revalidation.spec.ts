import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { OrgProfileService } from "./org-profile.service";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import type { OrganizationCreationService } from "./organization-creation.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { Db } from "../../../db/drizzle.types";
import {
  clearRegionRegistry,
  PlacementRefusedError,
  RegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "../../../common/region/region-registry";
import { resolveRegionTopology } from "../../../common/region/region.config";
import type { OrganizationPlacement } from "../../../common/region/placement";

const topology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_KEYS: "eu,us",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
  REGION_US_APP_DATABASE_URL: "postgres://us/main",
});

const ACTIVE_MEMBERSHIP = { role: "MEMBER", status: "ACTIVE" as const };
const ACTIVE_ORG = {
  id: "org-target",
  name: "Target Org",
  slug: "target-org",
  status: "ACTIVE",
  deletedAt: null,
};
const USER_WITH_OUTGOING_ORG = { lastActiveOrgId: "org-a" };

function makeSelectChain<T>(result: T[]) {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
    innerJoin: jest.fn(),
    orderBy: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, jest.Mock> = {
    set: jest.fn(),
    where: jest.fn().mockResolvedValue(undefined),
  };
  chain.set.mockReturnValue(chain);
  return chain;
}

interface TxOptions {
  membershipResult: unknown;
  orgRows?: unknown[];
  userRows?: unknown[];
}

function makeTx(opts: TxOptions) {
  const orgRows = opts.orgRows ?? [ACTIVE_ORG];
  const userRows = opts.userRows ?? [USER_WITH_OUTGOING_ORG];

  let selectCallCount = 0;
  const results = [orgRows, userRows];

  return {
    execute: jest.fn().mockResolvedValue([]),
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(opts.membershipResult),
      },
    },
    select: jest.fn().mockImplementation(() => {
      const idx = selectCallCount++;
      return makeSelectChain(results[idx] ?? []);
    }),
    update: jest.fn().mockReturnValue(makeUpdateChain()),
  };
}

function makeSwitchableDb(label: string, txOpts: TxOptions): { db: Db; opened: string[] } {
  const opened: string[] = [];
  const tx = makeTx(txOpts);
  const db = {
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      opened.push(label);
      return fn(tx);
    }),
  } as unknown as Db;
  return { db, opened };
}

function makeMinimalPrimaryDb(): Db {
  return {
    transaction: jest.fn().mockRejectedValue(
      new Error("primary db transaction must not be called in switch path when registry is active"),
    ),
  } as unknown as Db;
}

function makeService(
  primaryDb: Db,
  opts?: {
    indexRefresh?: jest.Mock;
    indexActivate?: jest.Mock;
    indexList?: jest.Mock;
    cacheInvalidate?: jest.Mock;
  },
) {
  const cacheService = {
    invalidate: opts?.cacheInvalidate ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;

  const auditService = {
    log: jest.fn(),
  } as unknown as AuditService;

  // `switchOrg` no longer sequences the projection and the stamp itself: it asks the index service
  // to `activate`, which owns "stamp, and project first if there is nothing to stamp". That
  // sequencing is asserted against the real service in account-organization-index.spec.ts.
  const indexService = {
    refreshForUser: opts?.indexRefresh ?? jest.fn().mockResolvedValue(undefined),
    activate: opts?.indexActivate ?? jest.fn().mockResolvedValue(undefined),
    touchLastActivated: jest.fn().mockResolvedValue(true),
    listForUser: opts?.indexList ?? jest.fn().mockResolvedValue([]),
    rebuild: jest.fn(),
  } as unknown as AccountOrganizationIndexService;

  const creationService = {
    createFromProfile: jest.fn(),
    createFromSetup: jest.fn(),
  } as unknown as OrganizationCreationService;

  return new OrgProfileService(
    primaryDb,
    auditService,
    cacheService,
    indexService,
    creationService,
  );
}

const MOVING_PLACEMENT: OrganizationPlacement = {
  organizationId: "org-target",
  region: "us",
  cellId: "legacy-1",
  databaseShard: "primary",
  objectStorageRegion: "us-east-1",
  searchCluster: "primary",
  placementVersion: 1,
  writeFenceToken: null,
  leaseExpiresAt: null,
  status: "MOVING",
};

const READ_ONLY_PLACEMENT: OrganizationPlacement = {
  ...MOVING_PLACEMENT,
  status: "READ_ONLY",
};

describe("OrgProfileService.switchOrg — placement-aware revalidation", () => {
  afterEach(() => clearRegionRegistry());

  describe("criterion 6 — stale index cannot grant access", () => {
    it("denies the switch when membership is absent in the target cell even though index listed it", async () => {
      const { db: targetDb } = makeSwitchableDb("us", {
        membershipResult: null,
      });

      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockResolvedValue({ region: "us" }),
        bindingFor: jest.fn().mockReturnValue({ db: targetDb }),
      } as unknown as RegionRegistry);

      const service = makeService(makeMinimalPrimaryDb());

      await expect(service.switchOrg("user-1", "org-target")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("bite check — if membership lookup is not guarded, stale access is granted", async () => {
      const { db: targetDb } = makeSwitchableDb("us", {
        membershipResult: ACTIVE_MEMBERSHIP,
      });

      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockResolvedValue({ region: "us" }),
        bindingFor: jest.fn().mockReturnValue({ db: targetDb }),
      } as unknown as RegionRegistry);

      const service = makeService(makeMinimalPrimaryDb());

      await expect(service.switchOrg("user-1", "org-target")).resolves.toMatchObject({
        orgId: "org-target",
        role: "MEMBER",
      });
    });
  });

  describe("placement guards", () => {
    it("refuses the switch when the target org placement is MOVING", async () => {
      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockRejectedValue(
          new PlacementRefusedError(
            "PLACEMENT_RELOCATING",
            "Organisation is moving",
            true,
            5000,
            MOVING_PLACEMENT,
          ),
        ),
        bindingFor: jest.fn(),
      } as unknown as RegionRegistry);

      const service = makeService(makeMinimalPrimaryDb());

      await expect(service.switchOrg("user-1", "org-target")).rejects.toBeInstanceOf(
        PlacementRefusedError,
      );
    });

    it("refuses the switch when the target org placement is READ_ONLY", async () => {
      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockRejectedValue(
          new PlacementRefusedError(
            "PLACEMENT_READ_ONLY",
            "Organisation is read-only",
            false,
            null,
            READ_ONLY_PLACEMENT,
          ),
        ),
        bindingFor: jest.fn(),
      } as unknown as RegionRegistry);

      const service = makeService(makeMinimalPrimaryDb());

      await expect(service.switchOrg("user-1", "org-target")).rejects.toBeInstanceOf(
        PlacementRefusedError,
      );
    });

    it("maps an unplaced org to NotFoundException, not a 500 or internal message", async () => {
      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockRejectedValue(
          new Error("[region] organisation org-target has no region"),
        ),
        bindingFor: jest.fn(),
      } as unknown as RegionRegistry);

      const service = makeService(makeMinimalPrimaryDb());

      const err = await service.switchOrg("user-1", "org-target").catch((e) => e);

      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as Error).message).not.toContain("[region]");
    });
  });

  describe("target cell connection", () => {
    it("runs the membership check on the target cell's connection, not the primary", async () => {
      const usOpened: string[] = [];
      const euOpened: string[] = [];
      const primaryOpened: string[] = [];

      const usTx = makeTx({ membershipResult: ACTIVE_MEMBERSHIP });
      const usDb = {
        transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          usOpened.push("us");
          return fn(usTx);
        }),
      } as unknown as Db;

      const euDb = {
        transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          euOpened.push("eu");
          return fn(makeTx({ membershipResult: ACTIVE_MEMBERSHIP }));
        }),
      } as unknown as Db;

      const primaryDb = {
        transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          primaryOpened.push("primary");
          return fn(makeTx({ membershipResult: ACTIVE_MEMBERSHIP }));
        }),
      } as unknown as Db;

      const bindings = new Map<string, RegionBinding>(
        Object.values(topology.regions).map((definition) => [
          definition.key,
          { definition, db: definition.key === "us" ? usDb : euDb },
        ]),
      );

      setRegionRegistry(
        new RegionRegistry(topology, bindings, async (orgId) => {
          if (orgId === "org-target") return "us";
          return null;
        }),
      );

      const service = makeService(primaryDb);
      await service.switchOrg("user-1", "org-target");

      expect(usOpened).toHaveLength(1);
      expect(euOpened).toHaveLength(0);
      expect(primaryOpened).toHaveLength(0);
    });

    it("falls back to this.db when no registry is configured (unit-test path)", async () => {
      clearRegionRegistry();

      const { db: fallbackDb, opened } = makeSwitchableDb("fallback", {
        membershipResult: ACTIVE_MEMBERSHIP,
      });

      const service = makeService(fallbackDb);
      await service.switchOrg("user-1", "org-target");

      expect(opened).toHaveLength(1);
    });
  });

  describe("outgoing org cache invalidation (criterion 5)", () => {
    it("invalidates the outgoing org authorization snapshot after a successful switch", async () => {
      const { db: targetDb } = makeSwitchableDb("us", {
        membershipResult: ACTIVE_MEMBERSHIP,
        userRows: [{ lastActiveOrgId: "org-a" }],
      });

      const cacheInvalidate = jest.fn().mockResolvedValue(undefined);

      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockResolvedValue({ region: "us" }),
        bindingFor: jest.fn().mockReturnValue({ db: targetDb }),
      } as unknown as RegionRegistry);

      const service = makeService(makeMinimalPrimaryDb(), { cacheInvalidate });
      await service.switchOrg("user-1", "org-target");

      expect(cacheInvalidate).toHaveBeenCalledWith(CACHE_KEYS.accessVersion("org-a"));
    });

    it("does not call accessVersion invalidation when the user had no previous org", async () => {
      const { db: targetDb } = makeSwitchableDb("us", {
        membershipResult: ACTIVE_MEMBERSHIP,
        userRows: [{ lastActiveOrgId: null }],
      });

      const cacheInvalidate = jest.fn().mockResolvedValue(undefined);

      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockResolvedValue({ region: "us" }),
        bindingFor: jest.fn().mockReturnValue({ db: targetDb }),
      } as unknown as RegionRegistry);

      const service = makeService(makeMinimalPrimaryDb(), { cacheInvalidate });
      await service.switchOrg("user-1", "org-target");

      const accessVersionCalls = (cacheInvalidate.mock.calls as string[][]).filter(
        ([key]) => key.startsWith("access:version:"),
      );
      expect(accessVersionCalls).toHaveLength(0);
    });

    it("still invalidates userSession regardless of outgoing org", async () => {
      const { db: targetDb } = makeSwitchableDb("us", {
        membershipResult: ACTIVE_MEMBERSHIP,
        userRows: [{ lastActiveOrgId: null }],
      });

      const cacheInvalidate = jest.fn().mockResolvedValue(undefined);

      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockResolvedValue({ region: "us" }),
        bindingFor: jest.fn().mockReturnValue({ db: targetDb }),
      } as unknown as RegionRegistry);

      const service = makeService(makeMinimalPrimaryDb(), { cacheInvalidate });
      await service.switchOrg("user-1", "org-target");

      expect(cacheInvalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("user-1"));
    });
  });

  describe("landing index activation", () => {
    function arrangeSwitch(opts: {
      indexActivate?: jest.Mock;
      indexRefresh?: jest.Mock;
      cacheInvalidate?: jest.Mock;
    }) {
      const { db: targetDb } = makeSwitchableDb("us", {
        membershipResult: ACTIVE_MEMBERSHIP,
        userRows: [{ lastActiveOrgId: null }],
      });

      setRegionRegistry({
        admittedPlacementForOrg: jest.fn().mockResolvedValue({ region: "us" }),
        bindingFor: jest.fn().mockReturnValue({ db: targetDb }),
      } as unknown as RegionRegistry);

      return makeService(makeMinimalPrimaryDb(), opts);
    }

    it("stamps the landing org on the index for the switching user", async () => {
      const indexActivate = jest.fn().mockResolvedValue(undefined);

      const service = arrangeSwitch({ indexActivate });
      await service.switchOrg("user-1", "org-target");

      expect(indexActivate).toHaveBeenCalledWith("user-1", "org-target");
    });

    it("stamps before dropping the session cache, so a concurrent read cannot re-cache the outgoing org", async () => {
      const order: string[] = [];
      const indexActivate = jest.fn(async () => {
        order.push("activate");
      });
      const cacheInvalidate = jest.fn(async () => {
        order.push("invalidate");
      });

      const service = arrangeSwitch({ indexActivate, cacheInvalidate });
      await service.switchOrg("user-1", "org-target");

      expect(order[0]).toBe("activate");
      expect(order).toContain("invalidate");
    });

    // The opportunistic refresh that follows the audit entry is fire-and-forget; a failure there
    // must not reach the caller, who has already switched.
    it("completes the switch when the opportunistic index refresh fails", async () => {
      const indexRefresh = jest.fn().mockRejectedValue(new Error("projection down"));

      const service = arrangeSwitch({ indexRefresh });
      const result = await service.switchOrg("user-1", "org-target");
      await new Promise((resolve) => setImmediate(resolve));

      expect(indexRefresh).toHaveBeenCalledWith("user-1");
      expect(result.orgId).toBe("org-target");
    });
  });
});
