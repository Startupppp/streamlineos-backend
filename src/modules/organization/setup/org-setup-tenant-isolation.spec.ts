import { OrgSetupService } from "./org-setup.service";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import type { Db } from "../../../db/drizzle.module";
import { OrganizationCreationService } from "../core/organization-creation.service";

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
  unplaceOrganization: jest.fn().mockResolvedValue(undefined),
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

type SelectChain = PromiseLike<unknown[]> & Record<string, unknown>;

/**
 * A select chain that answers EVERY builder method the service might call and
 * resolves to `rows` when awaited. The previous double answered only
 * `from().where()`, while `listSetupMemberships` calls `.leftJoin()`; the
 * service died on `tx.select(...).from(...).leftJoin is not a function` and the
 * TypeError was swallowed by a bare `catch {}`, so both tests in this file
 * passed without ever reaching an authorization decision.
 */
function makeSelectChain(rows: unknown[], whereArgs: unknown[]): SelectChain {
  const chain = new Proxy({} as SelectChain, {
    get(_target, prop) {
      if (prop === "then") return (resolve: (v: unknown[]) => unknown) => resolve(rows);
      return (...args: unknown[]) => {
        if (prop === "where") whereArgs.push(...args);
        return chain;
      };
    },
  });
  return chain;
}

describe("OrgSetupService — cross-tenant isolation", () => {
  const MEMBER_ORG = "org-the-user-belongs-to";
  const CLAIMED_ORG = "org-claimed-in-the-request";
  const USER_ID = "user-1";

  function makeService(options: {
    memberships: unknown[];
    currentMembership: { status: string; isOwner: boolean } | null;
    currentOrg: { id: string; name: string } | null;
  }) {
    const whereArgs: unknown[] = [];
    const select = jest.fn(() => makeSelectChain(options.memberships, whereArgs));

    const updateWhere = jest.fn().mockResolvedValue([]);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const insertValues = jest.fn().mockResolvedValue([{ id: "new-id" }]);

    const db = {
      select,
      update: jest.fn().mockReturnValue({ set: updateSet }),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(options.currentMembership) },
        organizations: { findFirst: jest.fn().mockResolvedValue(options.currentOrg) },
        subscriptions: { findFirst: jest.fn().mockResolvedValue(null) },
        magicLinkTokens: { findFirst: jest.fn().mockResolvedValue(null) },
        accountOrganizationIndex: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;

    const cache = {
      get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn(),
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
      cachedForOrg: jest.fn((_o: string, _k: string, fn: () => Promise<unknown>) => fn()),
    };
    const audit = { log: jest.fn() };
    const sessions = { skipSession: jest.fn().mockResolvedValue(undefined) };
    const creation = { createFromSetup: jest.fn() } as unknown as OrganizationCreationService;
    const resolver = new OrgSetupResolverService(db, cache as never, audit as never, creation);
    const accountOrgIndex = { refreshForUser: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrgSetupService(
      db,
      audit as never,
      cache as never,
      sessions as never,
      resolver,
      accountOrgIndex as never,
    );
    return { svc, db, sessions, whereArgs };
  }

  function membershipRow(orgId: string, isOwner: boolean) {
    return {
      id: 1,
      orgId,
      existingOrgId: orgId,
      orgName: orgId,
      orgStatus: "ACTIVE",
      orgDeletedAt: null,
      status: "ACTIVE" as const,
      isOwner,
    };
  }

  it("skipSetup derives the org from the membership table, never from the org id in the request context", async () => {
    const { svc, sessions } = makeService({
      memberships: [membershipRow(MEMBER_ORG, false)],
      currentMembership: null,
      currentOrg: null,
    });
    const userCtx = { userId: USER_ID, orgId: CLAIMED_ORG, isOwner: false, role: "MEMBER" as const };

    const error: unknown = await svc.skipSetup(userCtx as never).then(() => null, (e: unknown) => e);

    expect(error).toBeNull();
    expect(sessions.skipSession).toHaveBeenCalledTimes(1);
    expect(sessions.skipSession.mock.calls[0]?.[0]).toBe(MEMBER_ORG);
    expect(sessions.skipSession.mock.calls[0]?.[0]).not.toBe(CLAIMED_ORG);
  });

  it("skipSetup binds the membership lookup to the requesting user and never to the claimed org", async () => {
    const { svc, whereArgs } = makeService({
      memberships: [membershipRow(MEMBER_ORG, false)],
      currentMembership: null,
      currentOrg: null,
    });
    const userCtx = { userId: USER_ID, orgId: CLAIMED_ORG, isOwner: false, role: "MEMBER" as const };

    await svc.skipSetup(userCtx as never);

    expect(whereArgs.length).toBeGreaterThan(0);
    const values = whereArgs.flatMap((w) => sqlValues(w));
    expect(values).toContain(USER_ID);
    expect(values).not.toContain(CLAIMED_ORG);
  });

  it("skipSetup uses the requesting user's context org when they hold an ACTIVE membership in it (control)", async () => {
    const { svc, sessions } = makeService({
      memberships: [],
      currentMembership: { status: "ACTIVE", isOwner: false },
      currentOrg: { id: MEMBER_ORG, name: "Member Org" },
    });
    const userCtx = { userId: USER_ID, orgId: MEMBER_ORG, isOwner: false, role: "MEMBER" as const };

    const result = await svc.skipSetup(userCtx as never);

    expect(result).toEqual({ success: true, orgId: MEMBER_ORG });
    expect(sessions.skipSession).toHaveBeenCalledWith(MEMBER_ORG, USER_ID, "org_setup", undefined);
  });
});
