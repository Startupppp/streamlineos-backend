import { ForbiddenException } from "@nestjs/common";
import { RbacService } from "../rbac.service";
import { RolePermissionService } from "../role-permission.service";
import { resolveActorRankContext } from "../../../common/rbac/resolve-actor-rank";
import { ROLE_RANK } from "../../../common/rbac/grantability";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/rbac/resolve-actor-rank");
jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

const runInTenantTransactionMock = jest.fn();
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (
    db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
    opts?: unknown,
  ) => runInTenantTransactionMock(db, fn, opts),
}));

/**
 * `GET /rbac/discovery/grantable` tells a caller which authority ranks they may
 * put a role at. `RolePermissionService.setRolePermissions` decides the same
 * question when the caller actually writes. The read recomputed the comparison
 * as a raw `rank > bestRank` instead of calling `canGrantToRank`, so it dropped
 * the peer-MODULE_ADMIN exception the writer honours and told a module admin
 * they could not configure a peer role in their own module — which the writer
 * would in fact have allowed. Neither side may reimplement the other's rule.
 *
 * Each case below asks BOTH surfaces the same question and requires the same
 * answer. The write side is the real service, driven to the point where the
 * rank decision is the only thing that can differ between ranks.
 */

const CANDIDATE_RANKS = [
  ROLE_RANK.MODULE_ADMIN,
  ROLE_RANK.MODULE_CUSTOM,
  ROLE_RANK.FUNCTIONAL,
] as const;

const HELD_KEY = "hr:employees:view";

interface Scenario {
  label: string;
  bestRank: number;
  allowedModules: Set<string> | null;
  targetModuleKey: string | null;
}

const SCENARIOS: readonly Scenario[] = [
  {
    label: "HR module admin, configuring roles inside hr",
    bestRank: ROLE_RANK.MODULE_ADMIN,
    allowedModules: new Set(["hr"]),
    targetModuleKey: "hr",
  },
  {
    label: "org-wide actor whose top rank is MODULE_ADMIN but carries no module",
    bestRank: ROLE_RANK.MODULE_ADMIN,
    allowedModules: null,
    targetModuleKey: null,
  },
  {
    label: "org admin",
    bestRank: ROLE_RANK.ORG_ADMIN,
    allowedModules: null,
    targetModuleKey: null,
  },
];

function actorContext(): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId: "org-1",
    role: "ORG_ADMIN",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  } as CurrentUserContext;
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([[HELD_KEY, "all"]])),
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
  } as unknown as AccessService;
}

function makeTx() {
  return {
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
        then: (resolve: (value: unknown) => unknown) => resolve([]),
      }),
    }),
  };
}

function makeDb(role: {
  rank: number;
  moduleKey: string | null;
}): Db {
  return {
    query: {
      roles: {
        findFirst: jest.fn().mockResolvedValue({
          id: 42,
          orgId: "org-1",
          isSystem: false,
          version: 1,
          slug: "TARGET_ROLE",
          ...role,
        }),
      },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
  } as unknown as Db;
}

function makeCache(): CacheService {
  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateMany: jest.fn().mockResolvedValue(undefined),
    cached: jest
      .fn()
      .mockImplementation((_key: string, producer: () => Promise<unknown>) => producer()),
  } as unknown as CacheService;
}

function rbacServiceFor(scenario: Scenario): RbacService {
  const svc = Object.create(RbacService.prototype) as RbacService;
  Reflect.set(svc, "access", makeAccess());
  Reflect.set(svc, "db", {});
  return svc;
}

async function writePathAllows(scenario: Scenario, rank: number): Promise<boolean> {
  const tx = makeTx();
  runInTenantTransactionMock.mockImplementation(
    (_db: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  const svc = new RolePermissionService(
    makeDb({ rank, moduleKey: scenario.targetModuleKey }),
    makeCache(),
    { log: jest.fn() } as unknown as AuditService,
    makeAccess(),
  );
  try {
    await svc.setRolePermissions(actorContext(), 42, {
      version: 1,
      items: [{ permissionKey: HELD_KEY, scope: "all" }],
    });
    return true;
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  runInTenantTransactionMock.mockImplementation(
    (_db: unknown, fn: (t: unknown) => Promise<unknown>) => fn(makeTx()),
  );
});

describe("getDiscoveryGrantable.assignableRanks agrees with the writer, rank by rank", () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.label, () => {
      beforeEach(() => {
        (resolveActorRankContext as jest.Mock).mockResolvedValue({
          bestRank: scenario.bestRank,
          allowedModules: scenario.allowedModules,
        });
      });

      for (const rank of CANDIDATE_RANKS) {
        it(`rank ${rank}: the advertised answer is the answer the writer gives`, async () => {
          const read = await rbacServiceFor(scenario).getDiscoveryGrantable(actorContext());
          const advertised = read.assignableRanks.includes(rank);
          const allowed = await writePathAllows(scenario, rank);
          expect(advertised).toBe(allowed);
        });
      }
    });
  }

  it("the peer-MODULE_ADMIN exception is the case that separates the two rules", async () => {
    const peer = SCENARIOS[0];
    if (!peer) throw new Error("scenario missing");
    (resolveActorRankContext as jest.Mock).mockResolvedValue({
      bestRank: peer.bestRank,
      allowedModules: peer.allowedModules,
    });

    await expect(writePathAllows(peer, ROLE_RANK.MODULE_ADMIN)).resolves.toBe(true);
    const read = await rbacServiceFor(peer).getDiscoveryGrantable(actorContext());
    expect(read.assignableRanks).toContain(ROLE_RANK.MODULE_ADMIN);
  });

  it("without a module there is no peer exception, so neither side offers MODULE_ADMIN", async () => {
    const noModule = SCENARIOS[1];
    if (!noModule) throw new Error("scenario missing");
    (resolveActorRankContext as jest.Mock).mockResolvedValue({
      bestRank: noModule.bestRank,
      allowedModules: noModule.allowedModules,
    });

    await expect(writePathAllows(noModule, ROLE_RANK.MODULE_ADMIN)).resolves.toBe(false);
    const read = await rbacServiceFor(noModule).getDiscoveryGrantable(actorContext());
    expect(read.assignableRanks).not.toContain(ROLE_RANK.MODULE_ADMIN);
  });

  it("never advertises a rank the writer refuses outright", async () => {
    const orgAdmin = SCENARIOS[2];
    if (!orgAdmin) throw new Error("scenario missing");
    (resolveActorRankContext as jest.Mock).mockResolvedValue({
      bestRank: orgAdmin.bestRank,
      allowedModules: orgAdmin.allowedModules,
    });
    const read = await rbacServiceFor(orgAdmin).getDiscoveryGrantable(actorContext());
    expect(read.assignableRanks).not.toContain(ROLE_RANK.ORG_OWNER);
    expect(read.assignableRanks).not.toContain(ROLE_RANK.ORG_ADMIN);
    expect(read.assignableRanks).not.toContain(ROLE_RANK.MODULE_OWNER);
  });
});
