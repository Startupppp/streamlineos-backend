import { ForbiddenException } from "@nestjs/common";
import {
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  canGrantToRank,
  ROLE_RANK,
  toGrantableSet,
} from "../../../common/rbac/grantability";
import { resolveActorRankContext } from "../../../common/rbac/resolve-actor-rank";
import { RbacService } from "../rbac.service";
import { PERMISSIONS } from "../permissions";

jest.mock("../../../common/rbac/resolve-actor-rank");

const HR_KEYS = PERMISSIONS.filter((p) => p.name.startsWith("hr:")).map((p) => p.name);
const CRM_KEYS = PERMISSIONS.filter((p) => p.name.startsWith("crm:")).map((p) => p.name);

function resolvedMapFor(keys: string[]): ReadonlyMap<string, string> {
  return new Map(keys.map((k) => [k, "all"]));
}

function makeRbacService(overrides: {
  resolveUserPermissions?: (orgId: string, userId: string) => Promise<ReadonlyMap<string, string>>;
  resolveRankContext?: (orgId: string, userId: string) => Promise<{ bestRank: number; allowedModules: Set<string> | null }>;
}): RbacService {
  const svc = Object.create(RbacService.prototype) as RbacService;

  const access = {
    resolveUserPermissions: overrides.resolveUserPermissions ??
      jest.fn().mockResolvedValue(new Map()),
  };
  Reflect.set(svc, "access", access);
  Reflect.set(svc, "db", {});
  Reflect.set(svc, "rolesService", {});

  const mockFn = resolveActorRankContext as jest.Mock;
  if (overrides.resolveRankContext) {
    mockFn.mockImplementation(
      (_db: unknown, orgId: string, userId: string) =>
        overrides.resolveRankContext!(orgId, userId),
    );
  } else {
    mockFn.mockResolvedValue({ bestRank: ROLE_RANK.FUNCTIONAL, allowedModules: null });
  }

  return svc;
}

beforeEach(() => jest.clearAllMocks());

describe("getDiscoveryGrantable — Module Admin scoping", () => {
  it("returns only hr: keys for an HR Module Admin", async () => {
    const actor = {
      orgId: "org-1",
      userId: "user-hr",
      isOrgOwner: false,
    };

    const svc = makeRbacService({
      resolveUserPermissions: () => Promise.resolve(resolvedMapFor(HR_KEYS)),
      resolveRankContext: () =>
        Promise.resolve({
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["hr"]),
        }),
    });

    const result = await svc.getDiscoveryGrantable(actor as never);

    expect(result.allowedModules).toEqual(["hr"]);
    for (const key of result.grantableKeys) {
      expect(key.startsWith("hr:")).toBe(true);
    }
    for (const crmKey of CRM_KEYS) {
      expect(result.grantableKeys).not.toContain(crmKey);
    }
  });

  it("returns all keys for an org owner", async () => {
    const actor = {
      orgId: "org-1",
      userId: "user-owner",
      isOrgOwner: true,
    };

    const svc = makeRbacService({});

    const result = await svc.getDiscoveryGrantable(actor as never);

    expect(result.allowedModules).toBeNull();
    expect(result.grantableKeys.length).toBeGreaterThan(0);
    expect(result.grantableKeys).toContain(HR_KEYS[0]);
    expect(result.grantableKeys).toContain(CRM_KEYS[0]);
  });

  it("assignableRanks for a Module Admin excludes org-level ranks but keeps the peer exception the writer honours", async () => {
    const actor = {
      orgId: "org-1",
      userId: "user-hr",
      isOrgOwner: false,
    };

    const svc = makeRbacService({
      resolveUserPermissions: () => Promise.resolve(resolvedMapFor(HR_KEYS)),
      resolveRankContext: () =>
        Promise.resolve({
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["hr"]),
        }),
    });

    const result = await svc.getDiscoveryGrantable(actor as never);

    expect(result.assignableRanks).not.toContain(ROLE_RANK.ORG_OWNER);
    expect(result.assignableRanks).not.toContain(ROLE_RANK.ORG_ADMIN);
    expect(result.assignableRanks).not.toContain(ROLE_RANK.MODULE_OWNER);
    expect(result.assignableRanks).toContain(ROLE_RANK.MODULE_ADMIN);
    expect(result.assignableRanks).toContain(ROLE_RANK.MODULE_CUSTOM);
    expect(result.assignableRanks).toContain(ROLE_RANK.FUNCTIONAL);
  });

  it("advertises exactly what canGrantToRank answers, so the read cannot drift from the writer again", async () => {
    const allowedModules = new Set(["hr"]);
    const svc = makeRbacService({
      resolveUserPermissions: () => Promise.resolve(resolvedMapFor(HR_KEYS)),
      resolveRankContext: () =>
        Promise.resolve({ bestRank: ROLE_RANK.MODULE_ADMIN, allowedModules }),
    });

    const result = await svc.getDiscoveryGrantable({
      orgId: "org-1",
      userId: "user-hr",
      isOrgOwner: false,
    } as never);

    for (const rank of [ROLE_RANK.MODULE_ADMIN, ROLE_RANK.MODULE_CUSTOM, ROLE_RANK.FUNCTIONAL]) {
      expect(result.assignableRanks.includes(rank)).toBe(
        canGrantToRank(ROLE_RANK.MODULE_ADMIN, allowedModules, rank, "hr"),
      );
    }
  });

  it("a module admin with no module carries no peer exception", async () => {
    const svc = makeRbacService({
      resolveUserPermissions: () => Promise.resolve(resolvedMapFor(HR_KEYS)),
      resolveRankContext: () =>
        Promise.resolve({ bestRank: ROLE_RANK.MODULE_ADMIN, allowedModules: null }),
    });

    const result = await svc.getDiscoveryGrantable({
      orgId: "org-1",
      userId: "user-hr",
      isOrgOwner: false,
    } as never);

    expect(result.assignableRanks).not.toContain(ROLE_RANK.MODULE_ADMIN);
    expect(result.assignableRanks).toContain(ROLE_RANK.MODULE_CUSTOM);
  });

  it("does not advertise reserved admin permissions to a non-admin holder", async () => {
    const actor = {
      orgId: "org-1",
      userId: "user-role-manager",
      isOrgOwner: false,
    };
    const hrPermission = HR_KEYS[0] ?? "hr:employees:view";
    const svc = makeRbacService({
      resolveUserPermissions: () =>
        Promise.resolve(
          resolvedMapFor(["settings:rbac:manage", hrPermission]),
        ),
      resolveRankContext: () =>
        Promise.resolve({
          bestRank: ROLE_RANK.FUNCTIONAL,
          allowedModules: null,
        }),
    });

    const result = await svc.getDiscoveryGrantable(actor as never);

    expect(result.grantableKeys).not.toContain("settings:rbac:manage");
    expect(result.grantableKeys).toContain(hrPermission);
  });
});

describe("assertPermissionsGrantable — Module Admin rank boundary", () => {
  it("throws when a Module Admin tries to grant to a role at or above their own rank", () => {
    const hrGrantable = new Set(HR_KEYS);
    const actor = {
      isOrgOwner: false,
      grantable: hrGrantable,
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set(["hr"]),
    };

    const target = { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "hr" };
    const requestedKeys = HR_KEYS.slice(0, 2);
    const permMeta = buildPermissionModuleMap(requestedKeys);

    expect(() =>
      assertPermissionsGrantable(actor, requestedKeys, target, permMeta),
    ).not.toThrow();
  });

  it("throws when a Module Admin tries to grant to a peer role in a DIFFERENT module", () => {
    const hrGrantable = new Set(HR_KEYS);
    const actor = {
      isOrgOwner: false,
      grantable: hrGrantable,
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set(["hr"]),
    };

    const target = { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "crm" };
    const crmSample = CRM_KEYS.slice(0, 2);
    const permMeta = buildPermissionModuleMap(crmSample);

    expect(() =>
      assertPermissionsGrantable(actor, crmSample, target, permMeta),
    ).toThrow(ForbiddenException);
  });

  it("throws when a Module Admin tries to grant permissions from another module", () => {
    const hrGrantable = new Set(HR_KEYS);
    const actor = {
      isOrgOwner: false,
      grantable: hrGrantable,
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set(["hr"]),
    };

    const target = { rank: ROLE_RANK.FUNCTIONAL, moduleKey: null };
    const crossModuleKeys = [CRM_KEYS[0] ?? "crm:leads:view"];
    const permMeta = buildPermissionModuleMap(crossModuleKeys);

    expect(() =>
      assertPermissionsGrantable(actor, crossModuleKeys, target, permMeta),
    ).toThrow(ForbiddenException);
  });

  it("throws when actor tries to elevate above their own rank (no target.rank check exemption)", () => {
    const resolved = resolvedMapFor(HR_KEYS);
    const grantable = toGrantableSet(resolved);
    const actor = {
      isOrgOwner: false,
      grantable,
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set(["hr"]),
    };

    const target = { rank: ROLE_RANK.ORG_ADMIN, moduleKey: null };
    const requestedKeys = HR_KEYS.slice(0, 1);
    const permMeta = buildPermissionModuleMap(requestedKeys);

    expect(() =>
      assertPermissionsGrantable(actor, requestedKeys, target, permMeta),
    ).toThrow(ForbiddenException);
  });
});
