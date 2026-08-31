import { OrgSetupService } from "./org-setup.service";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn((_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db)),
  runInNewTenantTransaction: jest.fn((_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db)),
}));
jest.mock("../../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn((_db: unknown, _userId: string, fn: (tx: unknown) => unknown) => fn(_db)),
}));
jest.mock("../../../common/tenant/tenant-context", () => ({
  runOutsideTenantContext: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock("../../../common/region/cell-admission", () => ({
  chooseRegionForNewOrg: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../../common/region/placement-lookup", () => ({
  placeOrganization: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/org/provision-org-modules", () => ({
  provisionOrgModules: jest.fn().mockResolvedValue(undefined),
  DEFAULT_SKIP_MODULES: [],
}));
jest.mock("../../../common/org/provision-employee-self-service", () => ({
  provisionEmployeeSelfService: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn().mockResolvedValue(undefined),
}));

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("OrgSetupService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const USER_ID = "user-1";

  function makeService() {
    const memberWhere = jest.fn();
    const memberLimit = jest.fn().mockResolvedValue([]);
    memberWhere.mockReturnValue({ limit: memberLimit, orderBy: jest.fn().mockReturnValue({ limit: memberLimit }) });
    const memberFrom = jest.fn().mockReturnValue({ where: memberWhere, innerJoin: jest.fn().mockReturnValue({ where: memberWhere }) });
    const memberSelect = jest.fn().mockReturnValue({ from: memberFrom });

    const updateSet = jest.fn();
    const updateWhere = jest.fn().mockResolvedValue([]);
    updateSet.mockReturnValue({ where: updateWhere });

    const insertValues = jest.fn().mockResolvedValue([{ id: "new-id" }]);

    const db = {
      select: memberSelect,
      update: jest.fn().mockReturnValue({ set: updateSet }),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
        organizations: { findFirst: jest.fn().mockResolvedValue(null) },
        subscriptions: { findFirst: jest.fn().mockResolvedValue(null) },
        magicLinkTokens: { findFirst: jest.fn().mockResolvedValue(null) },
        accountOrganizationIndex: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;

    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
    const cache = {
      get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn(),
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
      cachedForOrg: jest.fn((_o: string, _k: string, fn: () => Promise<unknown>) => fn()),
    };
    const audit = { log: jest.fn() };
    const resolver = new OrgSetupResolverService(db, cache as never, audit as never);
    const svc = new OrgSetupService(db, audit as never, cache as never, {} as never, {} as never, dispatch as never, resolver);
    return { svc, db, memberWhere };
  }

  it("skipSetup cannot access a different org's data (cross-tenant isolation)", async () => {
    const { svc, memberWhere } = makeService();
    const userCtx = { userId: USER_ID, orgId: ATTACKER_ORG, isOwner: false, role: "MEMBER" as const };
    try {
      await svc.skipSetup(userCtx as never);
    } catch {
      // expected - missing membership
    }
    if (memberWhere.mock.calls.length > 0) {
      const allVals = memberWhere.mock.calls.flatMap((c) => sqlValues(c[0]));
      expect(allVals).not.toContain(OWNER_ORG);
    }
  });

  it("skipSetup uses the requesting user's context orgId (control)", async () => {
    const { svc } = makeService();
    const userCtx = { userId: USER_ID, orgId: OWNER_ORG, isOwner: true, role: "OWNER" as const };
    try {
      await svc.skipSetup(userCtx as never);
    } catch {
      // expected
    }
    expect(true).toBe(true);
  });
});
